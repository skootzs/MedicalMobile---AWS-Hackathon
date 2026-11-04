import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface StageResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface CompileStageInput {
  image: string;
  inDir: string;
  templateDir: string;
  compilerDir: string;
  outDir: string;
  snapshotHash: string;
  watermark?: string;
  baselineDir?: string;
  taskWindow?: string;
}

export interface ConvertStageInput {
  image: string;
  workDir: string;
}

export interface VerifyStageInput {
  image: string;
  projectDir: string;
  inDir: string; // holds logic.json, and golden-cases.json when goldenCasesHash is set
  verifierDir: string;
  outDir: string;
  packageHash: string;
  compileArtifactHash: string;
  logicModelHash: string;
  inputHash: string;
  goldenCasesHash?: string;
}

const BASE_FLAGS = ['--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--tmpfs', '/tmp', '--user', '1000:1000'];

export function compileArgs(input: CompileStageInput, name: string): string[] {
  return [
    'run', '--name', name, ...BASE_FLAGS,
    '-v', `${input.inDir}:/in:ro`,
    '-v', `${input.templateDir}:/template:ro`,
    '-v', `${input.compilerDir}:/compiler:ro`,
    '-v', `${input.outDir}:/out`,
    ...(input.baselineDir ? ['-v', `${input.baselineDir}:/baseline:ro`] : []),
    input.image,
    'node', '/compiler/src/cli.ts', '/in/logic.json',
    '--out', '/out', '--template', '/template', '--snapshot-hash', input.snapshotHash,
    ...(input.watermark ? ['--watermark', input.watermark] : []),
    ...(input.baselineDir ? ['--baseline', '/baseline'] : []),
    ...(input.taskWindow ? ['--task-window', input.taskWindow] : []),
  ];
}

export function convertArgs(input: ConvertStageInput, name: string): string[] {
  return [
    'run', '--name', name, ...BASE_FLAGS,
    '-e', 'SHIV_ROOT=/work/shiv', '-e', 'npm_config_cache=/tmp/npm', '-e', 'TZ=Africa/Nairobi',
    '-v', `${input.workDir}:/work`, '-w', '/work',
    input.image, 'sh', '/run-convert.sh',
  ];
}

export function verifyArgs(input: VerifyStageInput, name: string): string[] {
  return [
    // No added capabilities: run-verify.sh launches Chromium with --no-sandbox. See docs/decisions.md.
    'run', '--name', name, ...BASE_FLAGS,
    '-e', 'TZ=Africa/Nairobi', '-e', 'npm_config_cache=/tmp/npm',
    '-e', 'CHT_CONFIG_DIR=/project', '-e', 'OUT_DIR=/out',
    '-e', `PACKAGE_HASH=${input.packageHash}`,
    '-e', `COMPILE_ARTIFACT_HASH=${input.compileArtifactHash}`,
    '-e', `LOGIC_MODEL_HASH=${input.logicModelHash}`, // the envelope
    '-e', `INPUT_HASH=${input.inputHash}`, // the bare model
    ...(input.goldenCasesHash
      ? ['-e', 'GOLDEN_CASES_FILE=/in/golden-cases.json', '-e', `GOLDEN_CASES_HASH=${input.goldenCasesHash}`]
      : []),
    '-v', `${input.projectDir}:/project:ro`,
    '-v', `${input.inDir}:/in:ro`,
    '-v', `${input.verifierDir}:/verifier:ro`,
    '-v', `${input.outDir}:/out`,
    input.image, 'sh', '/run-verify.sh',
  ];
}

// Killing the docker client leaves the container running, so stop it by name.
async function runDocker(buildArgs: (name: string) => string[], signal: AbortSignal, timeoutMs: number): Promise<StageResult> {
  const name = `cht-nocode-${randomUUID()}`;
  const child = spawn('docker', buildArgs(name), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const stop = () => { spawn('docker', ['kill', name], { stdio: 'ignore' }).on('error', () => {}); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const onAbort = () => { aborted = true; stop(); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const exitCode = await new Promise<number>((resolve) => {
      child.on('error', (err) => { stderr += err.message; resolve(127); });
      child.on('close', (code) => resolve(code ?? 137));
    });
    return { exitCode, stdout, stderr, timedOut, aborted };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export interface Stages {
  compile(input: CompileStageInput, signal: AbortSignal, timeoutMs: number): Promise<StageResult>;
  convert(input: ConvertStageInput, signal: AbortSignal, timeoutMs: number): Promise<StageResult>;
  verify(input: VerifyStageInput, signal: AbortSignal, timeoutMs: number): Promise<StageResult>;
  imageDigest(image: string): Promise<string | undefined>;
  removeContainerFiles(dir: string, image: string): Promise<void>;
}

export const dockerStages: Stages = {
  compile: (input, signal, timeoutMs) => runDocker((name) => compileArgs(input, name), signal, timeoutMs),
  convert: (input, signal, timeoutMs) => runDocker((name) => convertArgs(input, name), signal, timeoutMs),
  verify: (input, signal, timeoutMs) => runDocker((name) => verifyArgs(input, name), signal, timeoutMs),
  async imageDigest(image) {
    const result = await runInspect(image);
    return result || undefined;
  },
  // Stage containers leave uid 1000 files, which a host user with another uid can't remove,
  // so a container with that uid removes them. Files it doesn't own are left to the caller.
  removeContainerFiles(dir, image) {
    return new Promise((resolve) => {
      const child = spawn('docker', [
        'run', '--rm', ...BASE_FLAGS, '-v', `${dir}:/clean`, image,
        'sh', '-c', 'chmod -R u+rwX /clean 2>/dev/null; find /clean -mindepth 1 -delete 2>/dev/null; true',
      ], { stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
  },
};

function runInspect(image: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['image', 'inspect', '--format', '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}', image], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => resolve(''));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : ''));
  });
}
