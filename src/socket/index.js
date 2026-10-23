export function configureSocket(io) {
  io.on('connection', socket => {
    console.log('[Socket] connected', socket.id);

    socket.on('join.trip', tripId => socket.join(`trip:${tripId}`));
    socket.on('join.sector', sector => socket.join(`sector:${sector}`));

    socket.on('disconnect', () => console.log('[Socket] disconnected', socket.id));
  });
}
