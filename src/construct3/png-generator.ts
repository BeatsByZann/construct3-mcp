/**
 * Minimal PNG generator for Construct 3 placeholder images.
 * Produces valid transparent PNGs without any image library dependencies.
 *
 * C3 image filename conventions (verified from real projects):
 * - Animation objects (Sprite, 3D Shape):
 *   `images/{objectname lowercase}-{animation name}-{frameIndex padded to 3}.png`
 * - Single-image objects (Tiled Background, Particles, Sprite Font, Tilemap,
 *   9-patch): `images/{objectname lowercase}.png`
 */

import { SINGLE_IMAGE_PLUGINS } from './templates.js';
import { deflateSync } from 'zlib';

/** PNG file signature (magic bytes) */
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Compute CRC32 for a buffer (used in PNG chunk checksums).
 */
function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Build a PNG chunk: 4-byte length + type + data + 4-byte CRC.
 */
function makeChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([length, typeBytes, data, crcVal]);
}

/**
 * Generate a minimal valid transparent PNG image.
 * Uses RGBA color type with all pixels fully transparent.
 *
 * @param width  Image width in pixels (default: 1)
 * @param height Image height in pixels (default: 1)
 * @returns Buffer containing a valid PNG file
 */
export function generatePlaceholderPng(width = 1, height = 1): Buffer {
  // IHDR chunk data: width(4) + height(4) + bitDepth(1) + colorType(1) + compression(1) + filter(1) + interlace(1)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data: each row has a filter byte (0 = None) followed by RGBA pixels (all zeroes = transparent)
  const rowSize = 1 + width * 4; // filter byte + RGBA per pixel
  const rawData = Buffer.alloc(rowSize * height); // already zeroed = transparent RGBA + filter=None

  // Compress with zlib
  const compressed = deflateSync(rawData);

  // IEND chunk (empty)
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', iend),
  ]);
}

/**
 * Get the image filename that C3 expects for a given object/animation/frame.
 *
 * @param objectName    Object type name (will be lowercased)
 * @param animationName Animation name (for Sprites; will be lowercased)
 * @param frameIndex    Frame index (0-based, zero-padded to 3 digits)
 * @param pluginId      Plugin ID — 'TiledBg' uses a simpler naming convention
 * @returns Filename like "hero-walk-000.png" or "tiledbackground.png"
 *
 * Construct saves the whole name in lowercase, the animation part included:
 * r495.2 stored an editor-made Sprite whose animation is "Animation 1" as
 * images/<name>-animation 1-000.png, and none of the 3,279 image files it saved
 * across C3-ACE and the reference packages has an uppercase letter. Looking up
 * the lowercase name finds a mixed-case file on Windows, whose lookups ignore
 * case, but not on a case-sensitive filesystem.
 */
export function getImageFileName(
  objectName: string,
  animationName: string,
  frameIndex: number,
  pluginId?: string,
): string {
  const lowerName = objectName.toLowerCase();

  // Every single-image object type in the sampled r495.2 projects stores its
  // PNG as images/<lowercase name>.png, not only Tiled Background.
  if (pluginId !== undefined && SINGLE_IMAGE_PLUGINS.has(pluginId)) {
    return `${lowerName}.png`;
  }

  // Sprite convention: name-animation-frameIndex(3 digits).png
  const paddedIndex = String(frameIndex).padStart(3, '0');
  return `${lowerName}-${animationName.toLowerCase()}-${paddedIndex}.png`;
}
