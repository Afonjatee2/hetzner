import { hashPassword } from "./password.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const password = await readStdin();
if (!password) {
  console.error("No password provided on stdin");
  process.exit(1);
}
console.log(hashPassword(password));
