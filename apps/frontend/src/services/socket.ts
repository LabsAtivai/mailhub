import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    const token = localStorage.getItem('access') || ''
    socket = io(window.location.origin, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: 10,
    })
    socket.on('connect_error', (err) => console.warn('[socket]', err.message))
  }
  return socket
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
}
