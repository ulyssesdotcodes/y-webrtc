'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var ws = require('lib0/websocket');
var map = require('lib0/map');
var error = require('lib0/error');
var random = require('lib0/random');
var encoding = require('lib0/encoding');
var decoding = require('lib0/decoding');
var observable = require('lib0/observable');
var logging = require('lib0/logging');
var promise = require('lib0/promise');
var bc = require('lib0/broadcastchannel');
var buffer = require('lib0/buffer');
var math = require('lib0/math');
var mutex = require('lib0/mutex');
require('yjs');
var syncProtocol = require('y-protocols/sync');
var awarenessProtocol = require('y-protocols/awareness');
var string = require('lib0/string');

/* eslint-env browser */

/**
 * @param {string} secret
 * @param {string} roomName
 * @return {PromiseLike<CryptoKey>}
 */
const deriveKey = (secret, roomName) => {
  const secretBuffer = string.encodeUtf8(secret).buffer;
  const salt = string.encodeUtf8(roomName).buffer;
  return crypto.subtle.importKey(
    'raw',
    secretBuffer,
    'PBKDF2',
    false,
    ['deriveKey']
  ).then(keyMaterial =>
    crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      {
        name: 'AES-GCM',
        length: 256
      },
      true,
      ['encrypt', 'decrypt']
    )
  )
};

/**
 * @param {Uint8Array} data data to be encrypted
 * @param {CryptoKey?} key
 * @return {PromiseLike<Uint8Array>} encrypted, base64 encoded message
 */
const encrypt = (data, key) => {
  if (!key) {
    return /** @type {PromiseLike<Uint8Array>} */ (promise.resolve(data))
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    key,
    data
  ).then(cipher => {
    const encryptedDataEncoder = encoding.createEncoder();
    encoding.writeVarString(encryptedDataEncoder, 'AES-GCM');
    encoding.writeVarUint8Array(encryptedDataEncoder, iv);
    encoding.writeVarUint8Array(encryptedDataEncoder, new Uint8Array(cipher));
    return encoding.toUint8Array(encryptedDataEncoder)
  })
};

/**
 * @param {Object} data data to be encrypted
 * @param {CryptoKey?} key
 * @return {PromiseLike<Uint8Array>} encrypted data, if key is provided
 */
const encryptJson = (data, key) => {
  const dataEncoder = encoding.createEncoder();
  encoding.writeAny(dataEncoder, data);
  return encrypt(encoding.toUint8Array(dataEncoder), key)
};

/**
 * @param {Uint8Array} data
 * @param {CryptoKey?} key
 * @return {PromiseLike<Uint8Array>} decrypted buffer
 */
const decrypt = (data, key) => {
  if (!key) {
    return /** @type {PromiseLike<Uint8Array>} */ (promise.resolve(data))
  }
  const dataDecoder = decoding.createDecoder(data);
  const algorithm = decoding.readVarString(dataDecoder);
  if (algorithm !== 'AES-GCM') {
    promise.reject(error.create('Unknown encryption algorithm'));
  }
  const iv = decoding.readVarUint8Array(dataDecoder);
  const cipher = decoding.readVarUint8Array(dataDecoder);
  return crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv
    },
    key,
    cipher
  ).then(data => new Uint8Array(data))
};

/**
 * @param {Uint8Array} data
 * @param {CryptoKey?} key
 * @return {PromiseLike<Object>} decrypted object
 */
const decryptJson = (data, key) =>
  decrypt(data, key).then(decryptedValue =>
    decoding.readAny(decoding.createDecoder(new Uint8Array(decryptedValue)))
  );

const log = logging.createModuleLogger('y-webrtc');

const messageSync = 0;
const messageQueryAwareness = 3;
const messageAwareness = 1;
const messageBcPeerId = 4;

/**
 * @type {Map<string, SignalingConn>}
 */
const signalingConns = new Map();

/**
 * @type {Map<string,Room>}
 */
const rooms = new Map();

/**
 * @param {Room} room
 * @param {Uint8Array} buf
 * @param {function} syncedCallback
 * @return {encoding.Encoder?}
 */
const readMessage = (room, buf, syncedCallback) => {
  const decoder = decoding.createDecoder(buf);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  if (room === undefined) {
    return null
  }
  const awareness = room.awareness;
  const doc = room.doc;
  let sendReply = false;
  switch (messageType) {
    case messageSync: {
      encoding.writeVarUint(encoder, messageSync);
      const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, doc, room);
      if (syncMessageType === syncProtocol.messageYjsSyncStep2 && !room.synced) {
        syncedCallback();
      }
      if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
        sendReply = true;
      }
      break
    }
    case messageQueryAwareness:
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys())));
      sendReply = true;
      break
    case messageAwareness:
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), room);
      break
    case messageBcPeerId: {
      const add = decoding.readUint8(decoder) === 1;
      const peerName = decoding.readVarString(decoder);
      if (peerName !== room.peerId && ((room.bcConns.has(peerName) && !add) || (!room.bcConns.has(peerName) && add))) {
        const removed = [];
        const added = [];
        if (add) {
          room.bcConns.add(peerName);
          added.push(peerName);
        } else {
          room.bcConns.delete(peerName);
          removed.push(peerName);
        }
        room.provider.emit('peers', [{
          added,
          removed,
          webrtcPeers: Array.from(room.webrtcConns.keys()),
          bcPeers: Array.from(room.bcConns)
        }]);
        broadcastBcPeerId(room);
      }
      break
    }
    default:
      console.error('Unable to compute message');
      return encoder
  }
  if (!sendReply) {
    // nothing has been written, no answer created
    return null
  }
  return encoder
};

/**
 * @param {Room} room
 * @param {Uint8Array} m
 */
const broadcastWebrtcConn = (room, m) => {
  log('broadcast message in ', logging.BOLD, room.name, logging.UNBOLD);
  room.webrtcConns.forEach(conn => {
    try {
      conn.peer.send(m);
    } catch (e) {}
  });
};

class WebrtcConn {
  /**
   * @param {SignalingConn} signalingConn
   * @param {boolean} initiator
   * @param {string} remotePeerId
   * @param {Room} room
   */
  constructor (signalingConn, initiator, remotePeerId, room) {
    log('establishing connection to ', logging.BOLD, remotePeerId);
    this.room = room;
    this.remotePeerId = remotePeerId;
    this.closed = false;
    this.connected = false;
    this.synced = false;
    /**
     * @type {any}
     */
    /*
    this.peer = new Peer({ initiator, ...room.provider.peerOpts })
    this.peer.on('signal', signal => {
      publishSignalingMessage(signalingConn, room, { to: remotePeerId, from: room.peerId, type: 'signal', signal })
    })
    this.peer.on('connect', () => {
      log('connected to ', logging.BOLD, remotePeerId)
      this.connected = true
      // send sync step 1
      const provider = room.provider
      const doc = provider.doc
      const awareness = room.awareness
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeSyncStep1(encoder, doc)
      sendWebrtcConn(this, encoder)
      const awarenessStates = awareness.getStates()
      if (awarenessStates.size > 0) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageAwareness)
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awarenessStates.keys())))
        sendWebrtcConn(this, encoder)
      }
    })
    this.peer.on('close', () => {
      this.connected = false
      this.closed = true
      if (room.webrtcConns.has(this.remotePeerId)) {
        room.webrtcConns.delete(this.remotePeerId)
        room.provider.emit('peers', [{
          removed: [this.remotePeerId],
          added: [],
          webrtcPeers: Array.from(room.webrtcConns.keys()),
          bcPeers: Array.from(room.bcConns)
        }])
      }
      checkIsSynced(room)
      this.peer.destroy()
      log('closed connection to ', logging.BOLD, remotePeerId)
      announceSignalingInfo(room)
    })
    this.peer.on('error', err => {
      log('Error in connection to ', logging.BOLD, remotePeerId, ': ', err)
      announceSignalingInfo(room)
    })
    this.peer.on('data', data => {
      const answer = readPeerMessage(this, data)
      if (answer !== null) {
        sendWebrtcConn(this, answer)
      }
    })
    */
  }

  destroy () {
    this.peer.destroy();
  }
}

/**
 * @param {Room} room
 * @param {Uint8Array} m
 */
const broadcastBcMessage = (room, m) => encrypt(m, room.key).then(data =>
  room.mux(() =>
    bc.publish(room.name, data)
  )
);

/**
 * @param {Room} room
 * @param {Uint8Array} m
 */
const broadcastRoomMessage = (room, m) => {
  if (room.bcconnected) {
    broadcastBcMessage(room, m);
  }
  broadcastWebrtcConn(room, m);
};

/**
 * @param {Room} room
 */
const announceSignalingInfo = room => {
  signalingConns.forEach(conn => {
    // only subcribe if connection is established, otherwise the conn automatically subscribes to all rooms
    if (conn.connected) {
      conn.send({ type: 'subscribe', topics: [room.name] });
      if (room.webrtcConns.size < room.provider.maxConns) {
        publishSignalingMessage(conn, room, { type: 'announce', from: room.peerId });
      }
    }
  });
};

/**
 * @param {Room} room
 */
const broadcastBcPeerId = room => {
  if (room.provider.filterBcConns) {
    // broadcast peerId via broadcastchannel
    const encoderPeerIdBc = encoding.createEncoder();
    encoding.writeVarUint(encoderPeerIdBc, messageBcPeerId);
    encoding.writeUint8(encoderPeerIdBc, 1);
    encoding.writeVarString(encoderPeerIdBc, room.peerId);
    broadcastBcMessage(room, encoding.toUint8Array(encoderPeerIdBc));
  }
};

class Room {
  /**
   * @param {Y.Doc} doc
   * @param {WebrtcProvider} provider
   * @param {string} name
   * @param {CryptoKey|null} key
   */
  constructor (doc, provider, name, key) {
    /**
     * Do not assume that peerId is unique. This is only meant for sending signaling messages.
     *
     * @type {string}
     */
    this.peerId = random.uuidv4();
    this.doc = doc;
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = provider.awareness;
    this.provider = provider;
    this.synced = false;
    this.name = name;
    // @todo make key secret by scoping
    this.key = key;
    /**
     * @type {Map<string, WebrtcConn>}
     */
    this.webrtcConns = new Map();
    /**
     * @type {Set<string>}
     */
    this.bcConns = new Set();
    this.mux = mutex.createMutex();
    this.bcconnected = false;
    /**
     * @param {ArrayBuffer} data
     */
    this._bcSubscriber = data =>
      decrypt(new Uint8Array(data), key).then(m =>
        this.mux(() => {
          const reply = readMessage(this, m, () => {});
          if (reply) {
            broadcastBcMessage(this, encoding.toUint8Array(reply));
          }
        })
      );
    /**
     * Listens to Yjs updates and sends them to remote peers
     *
     * @param {Uint8Array} update
     * @param {any} origin
     */
    this._docUpdateHandler = (update, origin) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      broadcastRoomMessage(this, encoding.toUint8Array(encoder));
    };
    /**
     * Listens to Awareness updates and sends them to remote peers
     *
     * @param {any} changed
     * @param {any} origin
     */
    this._awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
      const changedClients = added.concat(updated).concat(removed);
      const encoderAwareness = encoding.createEncoder();
      encoding.writeVarUint(encoderAwareness, messageAwareness);
      encoding.writeVarUint8Array(encoderAwareness, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
      broadcastRoomMessage(this, encoding.toUint8Array(encoderAwareness));
    };

    this._beforeUnloadHandler = () => {
      awarenessProtocol.removeAwarenessStates(this.awareness, [doc.clientID], 'window unload');
      rooms.forEach(room => {
        room.disconnect();
      });
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this._beforeUnloadHandler);
    } else if (typeof process !== 'undefined') {
      process.on('exit', this._beforeUnloadHandler);
    }
  }

  connect () {
    this.doc.on('update', this._docUpdateHandler);
    this.awareness.on('update', this._awarenessUpdateHandler);
    // signal through all available signaling connections
    announceSignalingInfo(this);
    const roomName = this.name;
    bc.subscribe(roomName, this._bcSubscriber);
    this.bcconnected = true;
    // broadcast peerId via broadcastchannel
    broadcastBcPeerId(this);
    // write sync step 1
    const encoderSync = encoding.createEncoder();
    encoding.writeVarUint(encoderSync, messageSync);
    syncProtocol.writeSyncStep1(encoderSync, this.doc);
    broadcastBcMessage(this, encoding.toUint8Array(encoderSync));
    // broadcast local state
    const encoderState = encoding.createEncoder();
    encoding.writeVarUint(encoderState, messageSync);
    syncProtocol.writeSyncStep2(encoderState, this.doc);
    broadcastBcMessage(this, encoding.toUint8Array(encoderState));
    // write queryAwareness
    const encoderAwarenessQuery = encoding.createEncoder();
    encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness);
    broadcastBcMessage(this, encoding.toUint8Array(encoderAwarenessQuery));
    // broadcast local awareness state
    const encoderAwarenessState = encoding.createEncoder();
    encoding.writeVarUint(encoderAwarenessState, messageAwareness);
    encoding.writeVarUint8Array(encoderAwarenessState, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    broadcastBcMessage(this, encoding.toUint8Array(encoderAwarenessState));
  }

  disconnect () {
    // signal through all available signaling connections
    signalingConns.forEach(conn => {
      if (conn.connected) {
        conn.send({ type: 'unsubscribe', topics: [this.name] });
      }
    });
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'disconnect');
    // broadcast peerId removal via broadcastchannel
    const encoderPeerIdBc = encoding.createEncoder();
    encoding.writeVarUint(encoderPeerIdBc, messageBcPeerId);
    encoding.writeUint8(encoderPeerIdBc, 0); // remove peerId from other bc peers
    encoding.writeVarString(encoderPeerIdBc, this.peerId);
    broadcastBcMessage(this, encoding.toUint8Array(encoderPeerIdBc));

    bc.unsubscribe(this.name, this._bcSubscriber);
    this.bcconnected = false;
    this.doc.off('update', this._docUpdateHandler);
    this.awareness.off('update', this._awarenessUpdateHandler);
    this.webrtcConns.forEach(conn => conn.destroy());
  }

  destroy () {
    this.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler);
    } else if (typeof process !== 'undefined') {
      process.off('exit', this._beforeUnloadHandler);
    }
  }
}

/**
 * @param {Y.Doc} doc
 * @param {WebrtcProvider} provider
 * @param {string} name
 * @param {CryptoKey|null} key
 * @return {Room}
 */
const openRoom = (doc, provider, name, key) => {
  // there must only be one room
  if (rooms.has(name)) {
    throw error.create(`A Yjs Doc connected to room "${name}" already exists!`)
  }
  const room = new Room(doc, provider, name, key);
  rooms.set(name, /** @type {Room} */ (room));
  return room
};

/**
 * @param {SignalingConn} conn
 * @param {Room} room
 * @param {any} data
 */
const publishSignalingMessage = (conn, room, data) => {
  if (room.key) {
    encryptJson(data, room.key).then(data => {
      conn.send({ type: 'publish', topic: room.name, data: buffer.toBase64(data) });
    });
  } else {
    conn.send({ type: 'publish', topic: room.name, data });
  }
};

class SignalingConn extends ws.WebsocketClient {
  constructor (url) {
    super(url);
    /**
     * @type {Set<WebrtcProvider>}
     */
    this.providers = new Set();
    this.on('connect', () => {
      log(`connected (${url})`);
      const topics = Array.from(rooms.keys());
      this.send({ type: 'subscribe', topics });
      rooms.forEach(room =>
        publishSignalingMessage(this, room, { type: 'announce', from: room.peerId })
      );
    });
    this.on('message', m => {
      switch (m.type) {
        case 'publish': {
          const roomName = m.topic;
          const room = rooms.get(roomName);
          if (room == null || typeof roomName !== 'string') {
            return
          }
          const execMessage = data => {
            const webrtcConns = room.webrtcConns;
            const peerId = room.peerId;
            if (data == null || data.from === peerId || (data.to !== undefined && data.to !== peerId) || room.bcConns.has(data.from)) {
              // ignore messages that are not addressed to this conn, or from clients that are connected via broadcastchannel
              return
            }
            const emitPeerChange = webrtcConns.has(data.from)
              ? () => {}
              : () =>
                room.provider.emit('peers', [{
                  removed: [],
                  added: [data.from],
                  webrtcPeers: Array.from(room.webrtcConns.keys()),
                  bcPeers: Array.from(room.bcConns)
                }]);
            switch (data.type) {
              case 'announce':
                if (webrtcConns.size < room.provider.maxConns) {
                  //map.setIfUndefined(webrtcConns, data.from, () => new WebrtcConn(this, true, data.from, room))
                  emitPeerChange();
                }
                break
              case 'signal':
                if (data.to === peerId) {
                  //map.setIfUndefined(webrtcConns, data.from, () => new WebrtcConn(this, false, data.from, room)).peer.signal(data.signal)
                  emitPeerChange();
                }
                break
            }
          };
          if (room.key) {
            if (typeof m.data === 'string') {
              decryptJson(buffer.fromBase64(m.data), room.key).then(execMessage);
            }
          } else {
            execMessage(m.data);
          }
        }
      }
    });
    this.on('disconnect', () => log(`disconnect (${url})`));
  }
}

/**
 * @typedef {Object} ProviderOptions
 * @property {Array<string>} [signaling]
 * @property {string} [password]
 * @property {awarenessProtocol.Awareness} [awareness]
 * @property {number} [maxConns]
 * @property {boolean} [filterBcConns]
 * @property {any} [peerOpts]
 */

/**
 * @extends Observable<string>
 */
class WebrtcProvider extends observable.Observable {
  /**
   * @param {string} roomName
   * @param {Y.Doc} doc
   * @param {ProviderOptions?} opts
   */
  constructor (
    roomName,
    doc,
    {
      signaling = ['wss://signaling.yjs.dev', 'wss://y-webrtc-signaling-eu.herokuapp.com', 'wss://y-webrtc-signaling-us.herokuapp.com'],
      password = null,
      awareness = new awarenessProtocol.Awareness(doc),
      maxConns = 20 + math.floor(random.rand() * 15), // the random factor reduces the chance that n clients form a cluster
      filterBcConns = true,
      peerOpts = {} // simple-peer options. See https://github.com/feross/simple-peer#peer--new-peeropts
    } = {}
  ) {
    super();
    this.roomName = roomName;
    this.doc = doc;
    this.filterBcConns = filterBcConns;
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = awareness;
    this.shouldConnect = false;
    this.signalingUrls = signaling;
    this.signalingConns = [];
    this.maxConns = maxConns;
    this.peerOpts = peerOpts;
    /**
     * @type {PromiseLike<CryptoKey | null>}
     */
    this.key = password ? deriveKey(password, roomName) : /** @type {PromiseLike<null>} */ (promise.resolve(null));
    /**
     * @type {Room|null}
     */
    this.room = null;
    this.key.then(key => {
      this.room = openRoom(doc, this, roomName, key);
      if (this.shouldConnect) {
        this.room.connect();
      } else {
        this.room.disconnect();
      }
    });
    this.connect();
    this.destroy = this.destroy.bind(this);
    doc.on('destroy', this.destroy);
  }

  /**
   * @type {boolean}
   */
  get connected () {
    return this.room !== null && this.shouldConnect
  }

  connect () {
    this.shouldConnect = true;
    this.signalingUrls.forEach(url => {
      const signalingConn = map.setIfUndefined(signalingConns, url, () => new SignalingConn(url));
      this.signalingConns.push(signalingConn);
      signalingConn.providers.add(this);
    });
    if (this.room) {
      this.room.connect();
    }
  }

  disconnect () {
    this.shouldConnect = false;
    this.signalingConns.forEach(conn => {
      conn.providers.delete(this);
      if (conn.providers.size === 0) {
        conn.destroy();
        signalingConns.delete(conn.url);
      }
    });
    if (this.room) {
      this.room.disconnect();
    }
  }

  destroy () {
    this.doc.off('destroy', this.destroy);
    // need to wait for key before deleting room
    this.key.then(() => {
      /** @type {Room} */ (this.room).destroy();
      rooms.delete(this.roomName);
    });
    super.destroy();
  }
}

exports.Room = Room;
exports.SignalingConn = SignalingConn;
exports.WebrtcConn = WebrtcConn;
exports.WebrtcProvider = WebrtcProvider;
//# sourceMappingURL=y-webrtc.cjs.map