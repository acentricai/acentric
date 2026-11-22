// A tar archive of one file: what Docker takes to put a file into a container.

/** A field of a tar header: octal digits, then a NUL. */
function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

/**
 * An archive that holds one file, of this name, owned by this user and group and for its
 * owner alone to read and write.
 */
export function tarOf(file: {
  readonly name: string;
  readonly content: string;
  readonly uid: number;
  readonly gid: number;
  /** Seconds since the Unix epoch. */
  readonly mtime: number;
}): Buffer {
  const content = Buffer.from(file.content, 'utf8');
  const name = Buffer.from(file.name, 'utf8');
  if (name.length > 100) throw new RangeError(`A file's name in an archive is 100 bytes at most`);
  const header = Buffer.alloc(512);
  name.copy(header, 0);
  header.write(octal(0o600, 8), 100, 'ascii');
  header.write(octal(file.uid, 8), 108, 'ascii');
  header.write(octal(file.gid, 8), 116, 'ascii');
  header.write(octal(content.length, 12), 124, 'ascii');
  header.write(octal(file.mtime, 12), 136, 'ascii');
  // The checksum is counted with spaces where it goes.
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  // Two empty blocks end an archive.
  return Buffer.concat([header, content, padding, Buffer.alloc(1024)]);
}
