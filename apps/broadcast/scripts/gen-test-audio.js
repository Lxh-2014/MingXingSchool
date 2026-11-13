// 一次性脚本：生成一个 2 秒的正弦波 WAV 测试音，用于端到端验证广播链路。
// 运行：node scripts/gen-test-audio.js
const fs = require('fs');
const path = require('path');

const AUDIO_DIR = path.resolve(__dirname, '..', 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const sampleRate = 22050;    // 采样率
const seconds = 2;            // 时长
const freq = 440;             // 正弦波频率（A4）
const amp = 0.3;              // 振幅（0-1）
const numSamples = sampleRate * seconds;

// 16-bit 单声道 PCM
const pcm = Buffer.alloc(numSamples * 2);
for (let i = 0; i < numSamples; i++) {
  const t = i / sampleRate;
  const s = Math.sin(2 * Math.PI * freq * t) * amp;
  const int = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  pcm.writeInt16LE(int, i * 2);
}

// WAV header
const dataSize = pcm.length;
const fileSize = 44 + dataSize - 8; // 减去 RIFF + size 两字段
const buf = Buffer.alloc(44);
buf.write('RIFF', 0);
buf.writeUInt32LE(fileSize, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);      // Subchunk1Size
buf.writeUInt16LE(1, 20);       // PCM
buf.writeUInt16LE(1, 22);       // 单声道
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(dataSize, 40);

const out = Buffer.concat([buf, pcm]);
const outFile = path.join(AUDIO_DIR, 'test-chime.wav');
fs.writeFileSync(outFile, out);
console.log('已生成测试音频：' + outFile + '（' + out.length + ' 字节）');
