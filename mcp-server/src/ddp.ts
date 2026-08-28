import dgram from "node:dgram";
import type { RGB } from "./scenes.js";

// Distributed Display Protocol — verified against 3waylabs spec via LedFX and coral/ddp reference
// implementations. Header is 10 bytes: flags, sequence, data-type, dest-id, offset(u32be), length(u16be).
const DDP_PORT = 4048;
const MAX_PIXELS_PER_PACKET = 480; // keeps each UDP packet under standard Ethernet MTU
const FLAG_VERSION1 = 0x40;
const FLAG_PUSH = 0x01; // set on the last packet of a frame so the receiver displays immediately
const DATA_TYPE_RGB888 = 0x0b;
const DEFAULT_DEST_ID = 1;

export class DdpSender {
  private socket = dgram.createSocket("udp4");
  private seq = 0;

  // Reused across sendFrame calls to avoid per-frame allocation/GC churn during
  // long-running live streams (up to 60fps, potentially indefinite duration —
  // see play_scene_live). pixelBuf is resized on demand rather than up front
  // because the frame size isn't known until the first sendFrame call (and, in
  // principle, could change between calls if the caller's LED count changes).
  // headerPool grows on demand and is never shrunk — headers are tiny (10
  // bytes) and every byte is overwritten on each use, so stale slots are
  // harmless. This assumes sendFrame calls for a given sender aren't issued
  // concurrently (true for how liveStreamController drives it: each tick
  // awaits the previous sendFrame before the next is issued).
  private pixelBuf: Buffer | null = null;
  private headerPool: Buffer[] = [];

  constructor(private host: string, private port: number = DDP_PORT) {}

  /** pixels must already be in the device's flat DDP buffer order (deviceIndex order). */
  async sendFrame(pixels: RGB[]): Promise<void> {
    const totalBytes = pixels.length * 3;
    if (!this.pixelBuf || this.pixelBuf.length !== totalBytes) {
      this.pixelBuf = Buffer.alloc(totalBytes);
    }
    const buf = this.pixelBuf;
    pixels.forEach(([r, g, b], i) => {
      buf[i * 3] = r;
      buf[i * 3 + 1] = g;
      buf[i * 3 + 2] = b;
    });

    this.seq = (this.seq % 15) + 1;

    const sends: Promise<void>[] = [];
    let chunkIndex = 0;
    for (let offset = 0; offset < totalBytes; offset += MAX_PIXELS_PER_PACKET * 3) {
      const chunkLen = Math.min(MAX_PIXELS_PER_PACKET * 3, totalBytes - offset);
      const isLast = offset + chunkLen >= totalBytes;

      let header = this.headerPool[chunkIndex];
      if (!header) {
        header = Buffer.alloc(10);
        this.headerPool[chunkIndex] = header;
      }
      header[0] = FLAG_VERSION1 | (isLast ? FLAG_PUSH : 0);
      header[1] = this.seq;
      header[2] = DATA_TYPE_RGB888;
      header[3] = DEFAULT_DEST_ID;
      header.writeUInt32BE(offset, 4);
      header.writeUInt16BE(chunkLen, 8);

      // Pass the header and pixel slice as separate buffers rather than
      // Buffer.concat-ing a new packet each chunk — dgram's send() accepts an
      // array of buffers and writes them out as one datagram without an extra copy.
      sends.push(this.send([header, buf.subarray(offset, offset + chunkLen)]));
      chunkIndex++;
    }
    await Promise.all(sends);
  }

  private send(packet: Buffer | Buffer[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(packet, this.port, this.host, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): void {
    this.socket.close();
  }
}
