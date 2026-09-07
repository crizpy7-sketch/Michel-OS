import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { consumeStoredFactoryReceipt, loadPinnedFactory, type TrustedMichelQualityContext } from './factory-quality-consumer.ts';

// The operator/control-plane owns this executable context. It is outside receipt/request data.
// No context is shipped pretending that production evidence adapters have already been wired.
const [receiptPath, targetSha, expectedDigest, operationalRoot] = process.argv.slice(2);
let factory: Awaited<ReturnType<typeof loadPinnedFactory>> | undefined;
try {
  if (!receiptPath || !targetSha || !expectedDigest || !operationalRoot) throw new Error('Missing receipt, target, digest or operational root');
  const root = await realpath(operationalRoot);
  for (const directory of [root, join(root, '.swarm'), join(root, '.swarm/quality-governance')]) {
    const owner = await lstat(directory);
    if (!owner.isDirectory() || owner.isSymbolicLink() || (owner.mode & 0o022) !== 0
      || (process.getuid && ![0, process.getuid()].includes(owner.uid))) throw new Error('Untrusted context directory');
  }
  const contextPath = join(root, '.swarm/quality-governance/context.mjs');
  if (await realpath(contextPath) !== contextPath) throw new Error('Trusted context cannot use symlinked paths');
  const info = await lstat(contextPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0
    || (process.getuid && ![0, process.getuid()].includes(info.uid))) throw new Error('Trusted control-plane context is not an operator-owned non-writable module');
  const bytes = await readFile(receiptPath);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) throw new Error('Receipt file digest mismatch');
  factory = await loadPinnedFactory();
  const configured = await import(pathToFileURL(contextPath).href) as {
    createContext: (factory: Awaited<ReturnType<typeof loadPinnedFactory>>, target: string) => Promise<TrustedMichelQualityContext | null>;
  };
  if (typeof configured.createContext !== 'function') throw new Error('No trusted task/evidence resolver');
  const context = await configured.createContext(factory, targetSha);
  const result = consumeStoredFactoryReceipt(factory, JSON.parse(bytes.toString('utf8')), targetSha, context);
  console.log(JSON.stringify(result));
  if (result.state !== 'pass') process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ state: 'needs-evidence', reason: 'Trusted Factory runtime/context or valid retained receipt is unavailable',
    qualityEvidenceGrantsActionAuthority: false, cristianDeploymentApproval: 'required-separately' }));
  process.exitCode = 1;
} finally { await factory?.close(); }
