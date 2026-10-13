import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP writer.
 *
 * Windows users expect a .zip they can double-click, and the `zip` CLI is not
 * guaranteed to exist on the host, so the archive is built in-process. Only
 * what we need is implemented: deflate or stored entries, UTF-8 names, no
 * encryption, no ZIP64 (packages stay far below the 4 GiB limit).
 */

export interface ZipEntry {
  /** Path inside the archive; always use forward slashes. */
  name: string;
  data: Buffer | string;
  /** Modification time recorded in the entry. Defaults to now. */
  mtime?: Date;
  /** Force STORE (no compression); useful for already-compressed payloads. */
  store?: boolean;
}

/** MS-DOS packed date/time, as required by the ZIP format. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { time, date };
}

/** External attributes: regular file 0644, or directory 0755. */
function externalAttrs(isDir: boolean): number {
  return isDir ? 0x41ed0010 : 0x81a40000;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
/** Bit 11: filename is UTF-8. */
const FLAG_UTF8 = 0x0800;

export function createZip(entries: ZipEntry[]): Buffer {
  const body: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.name.endsWith('/');
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = isDir
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.data)
        ? entry.data
        : Buffer.from(entry.data, 'utf8');

    const crc = crc32(raw) >>> 0;

    // Prefer deflate, but fall back to STORE when it does not pay off.
    let method = 0;
    let payload = raw;
    if (!entry.store && raw.length > 0) {
      const deflated = deflateRawSync(raw, { level: 9 });
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }

    const { time, date } = dosDateTime(entry.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    body.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(externalAttrs(isDir), 38);
    cd.writeUInt32LE(offset, 42);

    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...body, centralBuf, end]);
}

/**
 * Convert LF line endings to CRLF.
 *
 * Windows batch files and Notepad misbehave with bare LF, so generated .cmd and
 * .txt files must use CRLF.
 */
export function toCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}
