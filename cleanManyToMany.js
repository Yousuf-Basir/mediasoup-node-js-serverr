import express from 'express';
import cors from 'cors';
import https from 'httpolyglot';
import fs from 'fs';
import path from 'path';
import { Server } from 'socket.io';
import mediasoup from 'mediasoup';
import http from 'http';
import { startRecording, stopRecording } from './libs/record.js';
import { startCombinedRecording, stopCombinedRecording } from './libs/combinedRecord.js';

const __dirname = path.resolve();

// SSL cert for HTTPS access
const options = {
  key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
  cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8'),
};

const app = express();
app.use(cors({ origin: '*' }));

// const httpsServer = https.createServer(options, app);
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: '*',
  },
});

// Socket.IO namespace
const connections = io.of('/mediasoup');

// Global state
let worker;
let rooms = {};
let peers = {};
let transports = [];
let producers = [];
let consumers = [];


// Mediasoup configuration
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  }
];

// Utility functions
const removeItems = (items, socketId, type) => {
  items.forEach(item => {
    if (item.socketId === socketId) {
      item[type].close()
    }
  })
  items = items.filter(item => item.socketId !== socketId)

  return items
}

const createRoom = async (roomName, socketId) => {
  let router1;
  let peers = [];
  if (rooms[roomName]) {
    router1 = rooms[roomName].router;
    peers = rooms[roomName].peers || [];
  } else {
    router1 = await worker.createRouter({ mediaCodecs });
  }
  console.log(`Router ID: ${router1.id}`, peers.length);
  rooms[roomName] = { router: router1, peers: [...peers, socketId] };
  return router1;
};

const addTransport = (transport, roomName, consumer, socket) => {
  transports = [...transports, { socketId: socket.id, transport, roomName, consumer }];
  peers[socket.id] = { ...peers[socket.id], transports: [...peers[socket.id].transports, transport.id] };
};

const addProducer = (producer, roomName, socket) => {
  producers = [...producers, { socketId: socket.id, producer, roomName }];
  peers[socket.id] = { ...peers[socket.id], producers: [...peers[socket.id].producers, producer.id] };
};

const addConsumer = (consumer, roomName, socket) => {
  consumers = [...consumers, { socketId: socket.id, consumer, roomName }];
  peers[socket.id] = { ...peers[socket.id], consumers: [...peers[socket.id].consumers, consumer.id] };
};

const informConsumers = (roomName, socketId, id) => {
  console.log(`just joined, id ${id} ${roomName}, ${socketId}`);
  producers.forEach(producerData => {
    if (producerData.socketId !== socketId && producerData.roomName === roomName) {
      const producerSocket = peers[producerData.socketId].socket;
      producerSocket.emit('new-producer', { producerId: id });
    }
  });
};

const getTransport = socketId => {
  const [producerTransport] = transports.filter(transport => transport.socketId === socketId && !transport.consumer);
  return producerTransport.transport;
};

// Express routes
app.get('*', (req, res, next) => {
  const path = '/sfu/';
  if (req.path.indexOf(path) === 0 && req.path.length > path.length) return next();
  res.send('You need to specify a room name in the path e.g. "https://127.0.0.1/sfu/room"');
});

app.use('/sfu/:room', express.static(path.join(__dirname, 'manyToMany')));

// Socket.IO event handlers
connections.on('connection', async socket => {
  console.log(socket.id);
  socket.emit('connection-success', { socketId: socket.id });

  socket.on('disconnect', () => {
    console.log('peer disconnected');
    consumers = removeItems(consumers, socket.id, 'consumer');
    producers = removeItems(producers, socket.id, 'producer');
    transports = removeItems(transports, socket.id, 'transport');
    const { roomName } = peers[socket.id];
    delete peers[socket.id];
    rooms[roomName] = { router: rooms[roomName].router, peers: rooms[roomName].peers.filter(id => id !== socket.id) };
  });

  socket.on('joinRoom', async ({ roomName, userName }, callback) => {
    const router1 = await createRoom(roomName, socket.id);
    peers[socket.id] = { socket, roomName, transports: [], producers: [], consumers: [], peerDetails: { name: userName, isAdmin: false } };
    callback({ rtpCapabilities: router1.rtpCapabilities });
  });

  socket.on('createWebRtcTransport', async ({ consumer }, callback) => {
    const roomName = peers[socket.id].roomName;
    const router = rooms[roomName].router;
    createWebRtcTransport(router).then(
      transport => {
        callback({
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          },
        });
        addTransport(transport, roomName, consumer, socket);
      },
      error => {
        console.log(error);
      }
    );
  });

  socket.on('getProducers', callback => {
    const { roomName } = peers[socket.id];
    let producerList = [];
    producers.forEach(producerData => {
      if (producerData.socketId !== socket.id && producerData.roomName === roomName) {
        producerList = [...producerList, producerData.producer.id];
      }
    });
    callback(producerList);
  });

  socket.on('transport-connect', ({ dtlsParameters }) => {
    console.log('DTLS PARAMS... ', { dtlsParameters });
    getTransport(socket.id).connect({ dtlsParameters });
  });

  socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
    const producer = await getTransport(socket.id).produce({
      kind,
      rtpParameters,
    });
    const { roomName } = peers[socket.id];
    addProducer(producer, roomName, socket);
    informConsumers(roomName, socket.id, producer.id);
    console.log('Producer ID: ', producer.id, producer.kind);
    producer.on('transportclose', () => {
      console.log('transport for this producer closed ');
      producer.close();
    });
    callback({
      id: producer.id,
      producersExist: producers.length > 1 ? true : false,
    });
  });

  socket.on('transport-recv-connect', async ({ dtlsParameters, serverConsumerTransportId }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`);
    const consumerTransport = transports.find(
      transportData => transportData.consumer && transportData.transport.id == serverConsumerTransportId
    ).transport;
    await consumerTransport.connect({ dtlsParameters });
  });

  socket.on('consume', async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => {
    try {
      const { roomName } = peers[socket.id];
      const router = rooms[roomName].router;
      let consumerTransport = transports.find(
        transportData => transportData.consumer && transportData.transport.id == serverConsumerTransportId
      ).transport;

      if (router.canConsume({
        producerId: remoteProducerId,
        rtpCapabilities,
      })) {
        const consumer = await consumerTransport.consume({
          producerId: remoteProducerId,
          rtpCapabilities,
          paused: true,
        });

        consumer.on('transportclose', () => {
          console.log('transport close from consumer');
        });

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed');
          socket.emit('producer-closed', { remoteProducerId });
          consumerTransport.close([]);
          transports = transports.filter(transportData => transportData.transport.id !== consumerTransport.id);
          consumer.close();
          consumers = consumers.filter(consumerData => consumerData.consumer.id !== consumer.id);
        });

        addConsumer(consumer, roomName, socket);

        const params = {
          id: consumer.id,
          producerId: remoteProducerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
        };

        callback({ params });
      }
    } catch (error) {
      console.log(error.message);
      callback({
        params: {
          error: error,
        },
      });
    }
  });

  socket.on('consumer-resume', async ({ serverConsumerId }) => {
    console.log('consumer resume');
    const { consumer } = consumers.find(consumerData => consumerData.consumer.id === serverConsumerId);
    await consumer.resume();
  });

  socket.on('startRecording', async ({ audioProducerId, videoProducerId }, callback) => {
    try {
      // Find both audio and video producers
      const audioProducer = producers.find(p => p.producer.id === audioProducerId)?.producer;
      const videoProducer = producers.find(p => p.producer.id === videoProducerId)?.producer;

      // Validate that both producers exist
      if (!audioProducer || !videoProducer) {
        callback({ error: 'One or both producers not found' });
        return;
      }

      // Validate producer kinds
      if (audioProducer.kind !== 'audio' || videoProducer.kind !== 'video') {
        callback({ error: 'Invalid producer kinds. Need one audio and one video producer.' });
        return;
      }

      const fileName = await startCombinedRecording(
        audioProducer,
        videoProducer,
        peers[socket.id].roomName,
        socket.id,
        rooms
      );

      callback({ success: true, fileName });
    } catch (error) {
      console.error('Error starting combined recording:', error);
      callback({ error: error.message });
    }
  });

  socket.on('stopRecording', async ({ audioProducerId, videoProducerId }, callback) => {
    try {
      const filePath = await stopCombinedRecording(audioProducerId, videoProducerId);
      if (!filePath) {
        callback({ error: 'Recording not found' });
        return;
      }
      callback({ success: true, filePath });
    } catch (error) {
      console.error('Error stopping combined recording:', error);
      callback({ error: error.message });
    }
  });

  // Add cleanup on disconnect
  socket.on('disconnect', () => {
    producers.forEach(producerData => {
      if (producerData.socketId === socket.id) {
        stopCombinedRecording(producerData.producer.id);
      }
    });
  });
});

const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
    try {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: '0.0.0.0', // replace with relevant IP address
            announcedIp: '103.191.179.241', // host ip address. on mac run this command: 
            // ifconfig | grep "inet " | grep -v 127.0.0.1
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      };

      // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
      let transport = await router.createWebRtcTransport(webRtcTransport_options);
      console.log(`transport id: ${transport.id}`);

      transport.on('dtlsstatechange', dtlsState => {
        if (dtlsState === 'closed') {
          transport.close();
        }
      });

      transport.on('close', () => {
        console.log('transport closed');
      });

      resolve(transport);
    } catch (error) {
      reject(error);
    }
  });
};

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 4000,
  });
  console.log(`worker pid ${worker.pid}`);
  worker.on('died', error => {
    console.error('mediasoup worker has died');
    setTimeout(() => process.exit(1), 2000);
  });
  return worker;
};

worker = createWorker();
httpServer.listen(3211, () => {
  console.log('listening on port: ' + 3211);
}); 