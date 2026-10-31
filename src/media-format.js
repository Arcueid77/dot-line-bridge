import {MAX_MEDIA_BYTES} from '@dot-bridge/core/channels/media.js';

export const MAX_LINE_IMAGE_BYTES = 1024 * 1024;
export const MAX_LINE_AUDIO_MS = 60000;
const invalid = () => new Error('LINE media requires a JPEG/PNG image up to 1 MiB or an M4A audio file up to 60 seconds and 5 MiB.');

function boxes(data, start, end) {
  const result = [];
  for (let offset = start; offset < end;) {
    if (end - offset < 8) throw invalid();
    let size = data.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      if (end - offset < 16) throw invalid();
      const extended = data.readBigUInt64BE(offset + 8);
      if (extended > BigInt(data.length)) throw invalid();
      size = Number(extended); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || size > end - offset) throw invalid();
    result.push({type: data.toString('ascii', offset + 4, offset + 8), start: offset + header, end: offset + size});
    offset += size;
    if (result.length > 256) throw invalid();
  }
  return result;
}

// Read the M4A container only; no codec, shell program or untrusted path runs.
export function m4aDuration(data) {
  const roots = boxes(data, 0, data.length);
  const fileType = roots[0];
  if (fileType?.type !== 'ftyp' || fileType.end - fileType.start < 8 ||
      !roots.some(box => box.type === 'mdat' && box.end > box.start)) throw invalid();
  const brands = data.toString('ascii', fileType.start, fileType.end);
  if (!['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42'].some(brand => brands.includes(brand))) throw invalid();
  const movies = roots.filter(box => box.type === 'moov');
  if (movies.length !== 1) throw invalid();
  const children = boxes(data, movies[0].start, movies[0].end);
  const headers = children.filter(box => box.type === 'mvhd');
  const tracks = children.filter(box => box.type === 'trak');
  if (headers.length !== 1 || !tracks.length) throw invalid();
  for (const track of tracks) {
    const media = boxes(data, track.start, track.end).filter(box => box.type === 'mdia');
    if (media.length !== 1) throw invalid();
    const handlers = boxes(data, media[0].start, media[0].end).filter(box => box.type === 'hdlr');
    if (handlers.length !== 1 || handlers[0].end - handlers[0].start < 12 ||
        data.toString('ascii', handlers[0].start + 8, handlers[0].start + 12) !== 'soun') throw invalid();
  }
  const header = headers[0];
  const version = data[header.start];
  const scaleOffset = header.start + (version === 0 ? 12 : 20);
  const durationOffset = scaleOffset + 4;
  if (![0, 1].includes(version) || header.end < durationOffset + (version === 0 ? 4 : 8)) throw invalid();
  const scale = data.readUInt32BE(scaleOffset);
  const duration = version === 0 ? BigInt(data.readUInt32BE(durationOffset)) : data.readBigUInt64BE(durationOffset);
  if (!scale || duration <= 0n || duration > BigInt(scale) * BigInt(MAX_LINE_AUDIO_MS / 1000)) throw invalid();
  return Number((duration * 1000n + BigInt(scale) - 1n) / BigInt(scale));
}

export function validateLineMedia({media, text}) {
  if (!media || !['image', 'audio'].includes(media.type) || !Buffer.isBuffer(media.data) || !media.data.length ||
      media.data.length > MAX_MEDIA_BYTES || (text !== undefined && (typeof text !== 'string' || !text.isWellFormed() ||
        text.length > 5000 || Buffer.byteLength(text) > 15000))) throw invalid();
  if (media.type === 'image') {
    const png = media.data.length >= 16 && media.data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpeg = media.data.length >= 4 && media.data[0] === 255 && media.data[1] === 216 && media.data[2] === 255;
    if (media.data.length > MAX_LINE_IMAGE_BYTES || !((png && media.mimeType === 'image/png') || (jpeg && media.mimeType === 'image/jpeg'))) throw invalid();
    return {extension: png ? 'png' : 'jpg'};
  }
  if (media.mimeType !== 'audio/mp4') throw invalid();
  return {extension: 'm4a', duration: m4aDuration(media.data)};
}
