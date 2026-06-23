import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null
let _initialized = false

export function getSocket(): Socket {
  if (!socket) {
    const token = localStorage.getItem('access') || ''
    socket = io(window.location.origin, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
    })
    socket.io.on('reconnect_attempt', () => {
      if (socket) socket.auth = { token: localStorage.getItem('access') || '' }
    })
  }
  return socket
}

export function isSocketInitialized() {
  return _initialized
}

export function setSocketInitialized(v: boolean) {
  _initialized = v
}

export function refreshSocketToken() {
  if (!socket) return
  const token = localStorage.getItem('access') || ''
  socket.auth = { token }
  if (socket.connected) {
    socket.disconnect().connect()
  }
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
  _initialized = false
}
