import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function argumentsByName(values) {
  const result = {};
  for (let index = 2; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (!name || !value) throw new Error("Expected --name value arguments.");
    result[name] = value;
  }
  return result;
}

const args = argumentsByName(process.argv);
for (const name of ["model", "tokenizer", "license", "output"]) {
  if (!args[name]) throw new Error(`Missing --${name}.`);
}

const source = await readFile(args.model);
const headerLength = Number(source.readBigUInt64LE(0));
const header = JSON.parse(source.subarray(8, 8 + headerLength).toString("utf8"));
const tensor = header.embeddings;
if (tensor?.dtype !== "F32" || tensor.shape?.length !== 2) {
  throw new Error("Expected a two-dimensional F32 embeddings tensor.");
}
const [rows, dimensions] = tensor.shape;
const dataStart = 8 + headerLength + tensor.data_offsets[0];
const sourceVectors = new Float32Array(source.buffer, source.byteOffset + dataStart, rows * dimensions);
const headerBytes = 16;
const scaleBytes = rows * Float32Array.BYTES_PER_ELEMENT;
const output = Buffer.alloc(headerBytes + scaleBytes + rows * dimensions);
output.write("PTNQ8\0\0\x01", 0, "binary");
output.writeUInt32LE(rows, 8);
output.writeUInt32LE(dimensions, 12);
const scales = new Float32Array(output.buffer, output.byteOffset + headerBytes, rows);
const vectors = new Int8Array(output.buffer, output.byteOffset + headerBytes + scaleBytes, rows * dimensions);
let maximumError = 0;
for (let row = 0; row < rows; row += 1) {
  let maximum = 0;
  for (let column = 0; column < dimensions; column += 1) {
    maximum = Math.max(maximum, Math.abs(sourceVectors[row * dimensions + column]));
  }
  const scale = maximum === 0 ? 1 : maximum / 127;
  scales[row] = scale;
  for (let column = 0; column < dimensions; column += 1) {
    const index = row * dimensions + column;
    vectors[index] = Math.max(-127, Math.min(127, Math.round(sourceVectors[index] / scale)));
    maximumError = Math.max(maximumError, Math.abs(sourceVectors[index] - vectors[index] * scale));
  }
}

const tokenizer = JSON.parse(await readFile(args.tokenizer, "utf8"));
const vocabulary = Object.entries(tokenizer.model.vocab).sort((left, right) => left[1] - right[1]).map(([token]) => token);
if (vocabulary.length !== rows) throw new Error(`Vocabulary has ${vocabulary.length} entries; model has ${rows}.`);

await mkdir(args.output, { recursive: true });
await writeFile(path.join(args.output, "potion-base-2m.q8.bin"), output);
await writeFile(path.join(args.output, "vocab.txt"), `${vocabulary.join("\n")}\n`);
await copyFile(args.license, path.join(args.output, "LICENSE"));
await writeFile(path.join(args.output, "README.md"), `# Potion Base 2M\n\nA per-token int8 quantisation of \`minishlab/potion-base-2M\` for local icon search. The original model has 29,528 token vectors with 64 dimensions and is MIT licensed.\n\nMaximum observed scalar quantisation error: ${maximumError}.\n`);
console.log(`Prepared ${rows} × ${dimensions} Potion embeddings (${output.length} bytes; maximum error ${maximumError}).`);
