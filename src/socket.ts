import { io } from "socket.io-client";

export const socket = io({
  autoConnect: true,
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionDelayMax: 3000,
});

export function emitAck<T>(event: string, payload: unknown, timeoutMs = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error: Error | null, response: T) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}
