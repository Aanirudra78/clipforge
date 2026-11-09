import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

/**
 * Minimal streaming ZIP writer (store / no compression).
 * Video files are already compressed, so storing them is both faster and
 * smaller in wall-clock terms than deflating. Uses data descriptors so we can
 * stream without knowing sizes up front.
 */

const hasCrc32 = typeof zlib.crc32 === 'function';

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Slow(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const crc32 = (buf) => (hasCrc32 ? zlib.crc32(buf) >>> 0 : crc32Slow(buf));

const DOS_TIME = (d) => (((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff);
const DOS_DATE = (d) => ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff);

function localHeader(nameBuf, date) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);        // version needed
  h.writeUInt16LE(0x0808, 6);    // data descriptor + utf8 names
  h.writeUInt16LE(0, 8);         // store
  h.writeUInt16LE(DOS_TIME(date), 10);
  h.writeUInt16LE(DOS_DATE(date), 12);
  h.writeUInt32LE(0, 14);        // crc (in descriptor)
  h.writeUInt32LE(0, 18);        // csize
  h.writeUInt32LE(0, 22);        // usize
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, nameBuf]);
}

function dataDescriptor(crc, size) {
  const d = Buffer.alloc(16);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(crc, 4);
  d.writeUInt32LE(size, 8);
  d.writeUInt32LE(size, 12);
  return d;
}

function centralHeader(nameBuf, date, crc, size, offset) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0808, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(DOS_TIME(date), 12);
  h.writeUInt16LE(DOS_DATE(date), 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(size, 20);
  h.writeUInt32LE(size, 24);
  h.writeUInt16LE(nameBuf.length, 28);
  h.writeUInt16LE(0, 30);
  h.writeUInt16LE(0, 32);
  h.writeUInt16LE(0, 34);
  h.writeUInt16LE(0, 36);
  h.writeUInt32LE(0, 38);
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, nameBuf]);
}

export function zipStream(entries) {
  async function* generate() {
    let offset = 0;
    const central = [];

    for (const entry of entries) {
      if (!entry.path || !fs.existsSync(entry.path)) continue;
      const stat = fs.statSync(entry.path);
      const date = stat.mtime instanceof Date ? stat.mtime : new Date();
      const nameBuf = Buffer.from(entry.name, 'utf8');

      // pass 1 — checksum
      let crc = 0;
      {
        // zlib.crc32(data, prev) chains the running value
        let c = 0;
        let slow = 0xffffffff;
        for await (const chunk of fs.createReadStream(entry.path)) {
          if (hasCrc32) c = zlib.crc32(chunk, c) >>> 0;
          else for (let i = 0; i < chunk.length; i++) slow = crcTable[(slow ^ chunk[i]) & 0xff] ^ (slow >>> 8);
        }
        crc = hasCrc32 ? c >>> 0 : (slow ^ 0xffffffff) >>> 0;
      }

      const head = localHeader(nameBuf, date);
      yield head;
      offset += head.length;

      for await (const chunk of fs.createReadStream(entry.path)) {
        offset += chunk.length;
        yield chunk;
      }

      const desc = dataDescriptor(crc, stat.size);
      yield desc;
      offset += desc.length;

      central.push(centralHeader(nameBuf, date, crc, stat.size, offset - desc.length - stat.size - head.length));
    }

    const cdStart = offset;
    for (const c of central) {
      yield c;
      offset += c.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    yield eocd;
  }

  return Readable.from(generate(), { highWaterMark: 1 << 20 });
}
