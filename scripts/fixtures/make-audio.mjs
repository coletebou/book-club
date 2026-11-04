#!/usr/bin/env node
// Generate small, committed audio fixtures with ffmpeg (synthetic tones, public domain by
// construction):
//
//   fixtures/audio/synthetic/   three tagged tracks with an embedded cover (APIC) on track 1:
//                               the "title, author and cover from tags" upload case.
//   fixtures/audio/alice-tiny/  twelve tiny tracks tagged exactly like LibriVox's Alice
//                               (title wonderland_ch_NN, artist Lewis Carroll, album
//                               "Alice in Wonderland", no picture) plus a cover JPEG in the
//                               folder: the "cover from the folder" and chapter-alignment case.
//   fixtures/audio/carol-tiny/  five tracks shaped exactly like LibriVox's "A Christmas Carol
//                               (version 7)" (christmas_carol_7_1410_librivox), a sixtieth of
//                               its length: an ID3v2.3 tag written here, unsynchronised as a
//                               whole as LibriVox's are (UTF-16 text, an APIC cover), and an
//                               ID3v1 tag at the end with the titles cut to 30 characters. A
//                               reader that walks the frames where they lie (music-metadata)
//                               finds only the ID3v1 tag.
//
// Usage: node scripts/fixtures/make-audio.mjs [synthetic] [alice-tiny] [carol-tiny]
// Each set named (every set when none is) is written again from nothing; on this box's ffmpeg and
// sharp the synthetic and alice-tiny files come out byte for byte as committed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'apps/server/package.json'));
const sharp = require('sharp');

const SETS = ['synthetic', 'alice-tiny', 'carol-tiny'];
const named = process.argv.slice(2);
for (const set of named) if (!SETS.includes(set)) throw new Error(`no fixture set "${set}": choose from ${SETS.join(', ')}`);
const sets = new Set(named.length > 0 ? named : SETS);

function coverSvg(title, subtitle, hue) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,22%)"/><stop offset="1" stop-color="#101010"/></linearGradient></defs>
  <rect width="600" height="600" fill="url(#g)"/>
  <rect x="30" y="30" width="540" height="540" fill="none" stroke="#c9a84c" stroke-width="4"/>
  <text x="300" y="290" font-family="serif" font-size="54" font-weight="bold" fill="#e3c77a" text-anchor="middle">${title}</text>
  <text x="300" y="360" font-family="serif" font-size="30" font-style="italic" fill="#eee" text-anchor="middle">${subtitle}</text>
</svg>`;
}

async function jpeg(svg, file, size) {
  await sharp(Buffer.from(svg)).resize(size, size).jpeg({ quality: 80 }).toFile(file);
}

function tone(out, { seconds, freq, tags, cover }) {
  const args = ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}:sample_rate=22050`];
  if (cover) args.push('-i', cover, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  args.push('-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', '-id3v2_version', '3');
  for (const [k, v] of Object.entries(tags)) args.push('-metadata', `${k}=${v}`);
  args.push(out);
  execFileSync('ffmpeg', args);
}

/* ID3 tags written byte by byte, as LibriVox's are ------------------------------------------- */

/** An ID3v2.3 frame: its id, its size as a plain number, two flag bytes (none set), its content. */
function frame23(id, content) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(content.length, 4);
  return Buffer.concat([head, content]);
}

/** UTF-16 with a byte-order mark: FF FE, then the text little-endian. */
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
/** A text frame in UTF-16 (encoding 1), as LibriVox writes its title, album, artist and track. */
const utf16Frame = (id, text) => frame23(id, Buffer.concat([Buffer.from([1]), utf16(text)]));
/** A text frame in ISO-8859-1 (encoding 0). */
const latin1Frame = (id, text) => frame23(id, Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]));

/**
 * Unsynchronisation (ID3v2.3 §5): a zero byte after every FF that comes before 111xxxxx or before
 * a zero, so that nothing in the tag looks like the start of an MPEG frame. Frame sizes are not
 * changed: they count the bytes as they were.
 */
function unsynchronise(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
    if (bytes[i] === 0xff && (i + 1 === bytes.length || bytes[i + 1] >= 0xe0 || bytes[i + 1] === 0)) out.push(0);
  }
  return Buffer.from(out);
}

/** An ID3v2.3 tag of these frames and padding, unsynchronised as a whole, its header saying so (flags 0x80). */
function unsynchronisedTag(frames, padding) {
  const body = unsynchronise(Buffer.concat([...frames, Buffer.alloc(padding)]));
  const n = body.length;
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0x80, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]), body]);
}

/** An ID3v1.1 tag: title, artist and album of 30 bytes each, no year, a comment of 28, the track and the genre. */
function id3v1({ title, artist, album, comment, track, genre }) {
  const tag = Buffer.alloc(128);
  tag.write('TAG', 0, 'latin1');
  tag.write(title, 3, 30, 'latin1');
  tag.write(artist, 33, 30, 'latin1');
  tag.write(album, 63, 30, 'latin1');
  tag.write(comment, 97, 28, 'latin1');
  tag[126] = track;
  tag[127] = genre;
  return tag;
}

const tmp = path.join(root, '.cache', 'fixture-build');
mkdirSync(tmp, { recursive: true });

// 1. Synthetic tagged audiobook with embedded cover art.
if (sets.has('synthetic')) {
  const synth = path.join(root, 'fixtures/audio/synthetic');
  rmSync(synth, { recursive: true, force: true });
  mkdirSync(synth, { recursive: true });
  const synthCover = path.join(tmp, 'synthetic-cover.jpg');
  await jpeg(coverSvg('The Synthetic Tale', 'Ada Tone', 200), synthCover, 300);
  const parts = ['The Beginning', 'The Middle', 'The End'];
  parts.forEach((title, i) => {
    tone(path.join(synth, `0${i + 1} - ${title}.mp3`), {
      seconds: 8,
      freq: 330 + i * 110,
      tags: { title, artist: 'Ada Tone', album_artist: 'Ada Tone', album: 'The Synthetic Tale', track: `${i + 1}/3`, genre: 'Audiobook' },
      cover: i === 0 ? synthCover : null,
    });
  });
  console.log('wrote', synth);
}

// 2. Twelve LibriVox-shaped Alice tracks (no picture) and a cover image in the folder.
if (sets.has('alice-tiny')) {
  const tiny = path.join(root, 'fixtures/audio/alice-tiny');
  rmSync(tiny, { recursive: true, force: true });
  mkdirSync(tiny, { recursive: true });
  await jpeg(coverSvg('Alice in Wonderland', 'LibriVox-style fixture', 30), path.join(tiny, 'Alice_in_Wonderland.jpg'), 240);
  for (let n = 1; n <= 12; n++) {
    const nn = String(n).padStart(2, '0');
    tone(path.join(tiny, `wonderland_ch_${nn}_64kb.mp3`), {
      seconds: 3 + (n % 4),
      freq: 220 + n * 30,
      tags: { title: `wonderland_ch_${nn}`, artist: 'Lewis Carroll', album: 'Alice in Wonderland', track: String(n) },
      cover: null,
    });
  }
  writeFileSync(path.join(tiny, 'README.txt'), 'Synthetic tones tagged like LibriVox alice_in_wonderland_librivox (generated by scripts/fixtures/make-audio.mjs).\n');
  console.log('wrote', tiny);
}

// 3. Five tracks tagged like LibriVox's A Christmas Carol (version 7), frame for frame: the
//    archive's address in two comments, album, genre, title, length (in seconds, as LibriVox
//    writes it), artist, track, encoder and an "other" picture, then padding.
if (sets.has('carol-tiny')) {
  const carol = path.join(root, 'fixtures/audio/carol-tiny');
  rmSync(carol, { recursive: true, force: true });
  mkdirSync(carol, { recursive: true });
  const archive = 'https://archive.org/details/christmas_carol_7_1410_librivox';
  const album = 'A Christmas Carol (version 7)';
  const artist = 'Charles Dickens';
  const cover = await sharp(Buffer.from(coverSvg('A Christmas Carol', 'Charles Dickens', 0))).resize(200, 200).jpeg({ quality: 80 }).toBuffer();
  const titles = ["01 - Stave 1: Marley's Ghost", '02 - Stave 2: The First of the Three Spirits', '03 - Stave 3: The Second of the Three Spirits', '04 - Stave 4: The Last of the Spirits', '05 - Stave 5: The End of It'];
  // The recordings last 53:28, 46:43, 62:35, 41:15 and 17:44: as many seconds.
  const lengths = [53, 47, 63, 41, 18];
  for (const [i, title] of titles.entries()) {
    const n = i + 1;
    // The audio alone, mono at 8 kb/s (MPEG-2 Layer III, as LibriVox's): ffmpeg writes no tag.
    const audio = path.join(tmp, `carol-${n}.mp3`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${196 + i * 49}:duration=${lengths[i]}:sample_rate=22050`, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '8k', '-map_metadata', '-1', '-id3v2_version', '0', '-write_id3v1', '0', audio]);
    const tag = unsynchronisedTag(
      [
        frame23('COMM', Buffer.concat([Buffer.from([1]), Buffer.from('XXX', 'latin1'), Buffer.from([0, 0]), utf16(archive)])),
        frame23('COMM', Buffer.concat([Buffer.from([0]), Buffer.from('eng\0', 'latin1'), Buffer.from(archive, 'latin1')])),
        utf16Frame('TALB', album),
        latin1Frame('TCON', 'Speech'),
        utf16Frame('TIT2', title),
        latin1Frame('TLEN', `${lengths[i]}.00`),
        utf16Frame('TPE1', artist),
        utf16Frame('TRCK', String(n)),
        latin1Frame('TSSE', 'LAME 64bits version 3.99.5 (http://lame.sf.net)'),
        frame23('APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0', 'latin1'), Buffer.from([0, 0]), cover])),
      ],
      256,
    );
    // LibriVox's ID3v1 titles are the first 30 characters, trailing spaces dropped; the comment is
    // the address cut to 28; genre 101 is Speech.
    const v1 = id3v1({ title: title.slice(0, 30).trimEnd(), artist, album, comment: archive.slice(0, 28), track: n, genre: 101 });
    writeFileSync(path.join(carol, `christmascarol_${n}_dickens_64kb.mp3`), Buffer.concat([tag, readFileSync(audio), v1]));
  }
  writeFileSync(
    path.join(carol, 'README.txt'),
    'Synthetic tones tagged like LibriVox christmas_carol_7_1410_librivox: ID3v2.3 tags unsynchronised as a whole, with UTF-16 text and an APIC cover, and ID3v1 tags with the titles cut to 30 characters (generated by scripts/fixtures/make-audio.mjs).\n',
  );
  console.log('wrote', carol);
}
