const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  existsSync,
  utimesSync,
} = require("node:fs");
const { join, basename } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

const ROOT_DIR = join(__dirname, "..");
const VERIFY_SCRIPT = join(ROOT_DIR, "scripts", "db-verify-backup.sh");
const RESTORE_SCRIPT = join(ROOT_DIR, "scripts", "db-restore.sh");
const BACKUP_SCRIPT = join(ROOT_DIR, "scripts", "db-backup.sh");
const POLICY_SCRIPT = join(ROOT_DIR, "scripts", "backup-security-policy.sh");
const PRUNE_SCRIPT = join(ROOT_DIR, "scripts", "db-prune-backups.sh");
const DRILL_SCRIPT = join(ROOT_DIR, "scripts", "db-drill.sh");

function runScript(scriptPath, args = [], extraEnv = {}) {
  const result = spawnSync("bash", [scriptPath, ...args], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function buildMockDockerScript(logFilePath) {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `LOG_FILE=${JSON.stringify(logFilePath)}`,
    "echo \"$*\" >> \"$LOG_FILE\"",
    "if [ \"${1:-}\" != \"compose\" ]; then",
    "  echo \"unsupported command: $*\" >&2",
    "  exit 1",
    "fi",
    "if [ \"${2:-}\" = \"cp\" ]; then",
    "  exit 0",
    "fi",
    "if [ \"${2:-}\" = \"exec\" ]; then",
    "  case \"$*\" in",
    "    *pg_dump*)",
    "      echo mock_dump_payload",
    "      exit 0",
    "      ;;",
    "  esac",
    "  exit 0",
    "fi",
    "echo \"unsupported docker compose action: $*\" >&2",
    "exit 1",
    "",
  ].join("\n");
}

function buildMockOpenSslScript() {
  return `#!/usr/bin/env bash
set -euo pipefail
input=""
output=""
mode="enc"
while [ $# -gt 0 ]; do
  case "$1" in
    -d)
      mode="dec"
      shift
      ;;
    -in)
      input="$2"
      shift 2
      ;;
    -out)
      output="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [ -z "$input" ] || [ -z "$output" ]; then
  echo "missing -in or -out" >&2
  exit 1
fi
cp "$input" "$output"
if [ "$mode" = "enc" ]; then
  echo mocked-openssl-encrypted >> "$output"
fi
exit 0
`;
}

test("db-verify-backup fails when input is missing", () => {
  const result = runScript(VERIFY_SCRIPT);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Usage:/);
});

test("db-verify-backup fails when input file does not exist", () => {
  const result = runScript(VERIFY_SCRIPT, ["/tmp/does-not-exist.dump"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /archivo no encontrado/);
});

test("db-verify-backup supports missing checksum when REQUIRE_BACKUP_CHECKSUM=false", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-verify-"));
  const dumpFile = join(tempDir, "sample.dump");

  try {
    writeFileSync(dumpFile, "demo dump content\n", "utf8");

    const result = runScript(VERIFY_SCRIPT, [dumpFile], {
      REQUIRE_BACKUP_CHECKSUM: "false",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /checksum faltante, validacion omitida/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-verify-backup fails when REQUIRE_BACKUP_CHECKSUM has invalid value", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-verify-invalid-env-"));
  const dumpFile = join(tempDir, "sample.dump");

  try {
    writeFileSync(dumpFile, "demo dump content\n", "utf8");

    const result = runScript(VERIFY_SCRIPT, [dumpFile], {
      REQUIRE_BACKUP_CHECKSUM: "invalid",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /REQUIRE_BACKUP_CHECKSUM invalido/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-verify-backup validates checksum sidecar successfully", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-verify-checksum-"));
  const dumpFile = join(tempDir, "sample.dump");
  const checksumFile = `${dumpFile}.sha256`;

  try {
    writeFileSync(dumpFile, "demo dump content for checksum\n", "utf8");

    const generate = spawnSync("sha256sum", [dumpFile], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(generate.status, 0);

    const output = String(generate.stdout || "").trim();
    const hash = output.split(" ")[0];
    writeFileSync(checksumFile, `${hash}  ${basename(dumpFile)}\n`, "utf8");

    const result = runScript(VERIFY_SCRIPT, [dumpFile]);

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /ok: checksum valido/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-verify-backup fails when checksum sidecar is invalid", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-verify-invalid-checksum-"));
  const dumpFile = join(tempDir, "sample.dump");
  const checksumFile = `${dumpFile}.sha256`;

  try {
    writeFileSync(dumpFile, "content that should fail checksum\n", "utf8");
    writeFileSync(checksumFile, `0000000000000000000000000000000000000000000000000000000000000000  ${basename(dumpFile)}\n`, "utf8");

    const result = runScript(VERIFY_SCRIPT, [dumpFile]);

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /FAILED|checksum/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-backup generates dump and checksum using mocked docker", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-backup-"));
  const backupDir = join(tempDir, "backups");
  const outputFile = join(backupDir, "generated.dump");
  const checksumFile = `${outputFile}.sha256`;
  const mockBinDir = join(tempDir, "mock-bin");
  const mockDocker = join(mockBinDir, "docker");

  try {
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(mockBinDir, { recursive: true });

    writeFileSync(
      mockDocker,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "if [ \"$1\" = \"compose\" ] && [ \"$2\" = \"exec\" ]; then",
        "  echo mock_dump_payload",
        "  exit 0",
        "fi",
        "echo \"mock docker unexpected args: $*\" >&2",
        "exit 1",
        "",
      ].join("\n"),
      "utf8"
    );
    chmodSync(mockDocker, 0o755);

    const result = runScript(BACKUP_SCRIPT, [outputFile], {
      BACKUP_DIR: backupDir,
      BACKUP_RETENTION_DAYS: "0",
      PATH: `${mockBinDir}:${process.env.PATH || ""}`,
    });

    assert.equal(result.status, 0);
    assert.ok(existsSync(outputFile));
    assert.ok(existsSync(checksumFile));

    const dumpBody = readFileSync(outputFile, "utf8");
    assert.match(dumpBody, /mock_dump_payload/);

    const checksumBody = readFileSync(checksumFile, "utf8");
    assert.match(checksumBody, /generated\.dump/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-backup supports encryption and offsite local copy", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-backup-encrypted-"));
  const backupDir = join(tempDir, "backups");
  const offsiteDir = join(tempDir, "offsite");
  const outputFile = join(backupDir, "encrypted.dump");
  const encryptedOutput = `${outputFile}.enc`;
  const checksumFile = `${encryptedOutput}.sha256`;
  const offsiteEncrypted = join(offsiteDir, basename(encryptedOutput));
  const offsiteChecksum = `${offsiteEncrypted}.sha256`;
  const mockBinDir = join(tempDir, "mock-bin");
  const mockDocker = join(mockBinDir, "docker");
  const mockOpenSsl = join(mockBinDir, "openssl");

  try {
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(offsiteDir, { recursive: true });
    mkdirSync(mockBinDir, { recursive: true });

    writeFileSync(mockDocker, buildMockDockerScript(join(tempDir, "docker.log")), "utf8");
    chmodSync(mockDocker, 0o755);

    writeFileSync(mockOpenSsl, buildMockOpenSslScript(), "utf8");
    chmodSync(mockOpenSsl, 0o755);

    const result = runScript(BACKUP_SCRIPT, [outputFile], {
      BACKUP_DIR: backupDir,
      BACKUP_RETENTION_DAYS: "0",
      BACKUP_ENCRYPTION_PASSPHRASE: "secret-pass",
      OFFSITE_URI: offsiteDir,
      PATH: `${mockBinDir}:${process.env.PATH || ""}`,
    });

    assert.equal(result.status, 0);
    assert.equal(existsSync(outputFile), false);
    assert.equal(existsSync(encryptedOutput), true);
    assert.equal(existsSync(checksumFile), true);
    assert.equal(existsSync(offsiteEncrypted), true);
    assert.equal(existsSync(offsiteChecksum), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-backup fails for s3 offsite when aws CLI is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-backup-s3-guard-"));
  const backupDir = join(tempDir, "backups");
  const outputFile = join(backupDir, "s3.dump");
  const mockBinDir = join(tempDir, "mock-bin");
  const mockDocker = join(mockBinDir, "docker");

  try {
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(mockBinDir, { recursive: true });

    writeFileSync(mockDocker, buildMockDockerScript(join(tempDir, "docker.log")), "utf8");
    chmodSync(mockDocker, 0o755);

    const result = runScript(BACKUP_SCRIPT, [outputFile], {
      BACKUP_DIR: backupDir,
      BACKUP_RETENTION_DAYS: "0",
      OFFSITE_URI: "s3://consenthub-backups/test",
      PATH: mockBinDir,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /aws CLI no encontrado/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-backup strict mode requires encryption passphrase", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-backup-strict-passphrase-"));
  const backupDir = join(tempDir, "backups");
  const outputFile = join(backupDir, "strict.dump");
  const mockBinDir = join(tempDir, "mock-bin");
  const mockDocker = join(mockBinDir, "docker");

  try {
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(mockBinDir, { recursive: true });

    writeFileSync(mockDocker, buildMockDockerScript(join(tempDir, "docker.log")), "utf8");
    chmodSync(mockDocker, 0o755);

    const result = runScript(BACKUP_SCRIPT, [outputFile], {
      BACKUP_DIR: backupDir,
      BACKUP_RETENTION_DAYS: "0",
      STRICT_BACKUP_SECRETS: "true",
      PATH: `${mockBinDir}:${process.env.PATH || ""}`,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /requiere BACKUP_ENCRYPTION_PASSPHRASE/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-backup strict mode rejects short passphrase", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-backup-strict-length-"));
  const backupDir = join(tempDir, "backups");
  const outputFile = join(backupDir, "strict.dump");
  const mockBinDir = join(tempDir, "mock-bin");
  const mockDocker = join(mockBinDir, "docker");

  try {
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(mockBinDir, { recursive: true });

    writeFileSync(mockDocker, buildMockDockerScript(join(tempDir, "docker.log")), "utf8");
    chmodSync(mockDocker, 0o755);

    const result = runScript(BACKUP_SCRIPT, [outputFile], {
      BACKUP_DIR: backupDir,
      BACKUP_RETENTION_DAYS: "0",
      STRICT_BACKUP_SECRETS: "true",
      BACKUP_ENCRYPTION_PASSPHRASE: "short-pass",
      PATH: `${mockBinDir}:${process.env.PATH || ""}`,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /minimo 16 caracteres/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-backup strict mode requires BACKUP_ENCRYPTION_KEY_ID", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-backup-strict-keyid-"));
  const backupDir = join(tempDir, "backups");
  const outputFile = join(backupDir, "strict.dump");
  const mockBinDir = join(tempDir, "mock-bin");
  const mockDocker = join(mockBinDir, "docker");

  try {
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(mockBinDir, { recursive: true });

    writeFileSync(mockDocker, buildMockDockerScript(join(tempDir, "docker.log")), "utf8");
    chmodSync(mockDocker, 0o755);

    const result = runScript(BACKUP_SCRIPT, [outputFile], {
      BACKUP_DIR: backupDir,
      BACKUP_RETENTION_DAYS: "0",
      STRICT_BACKUP_SECRETS: "true",
      BACKUP_ENCRYPTION_PASSPHRASE: "super-strong-pass-123",
      PATH: `${mockBinDir}:${process.env.PATH || ""}`,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /requiere BACKUP_ENCRYPTION_KEY_ID/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-backup can require encrypted offsite uploads", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-backup-offsite-encryption-"));
  const backupDir = join(tempDir, "backups");
  const outputFile = join(backupDir, "offsite.dump");
  const mockBinDir = join(tempDir, "mock-bin");
  const mockDocker = join(mockBinDir, "docker");

  try {
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(mockBinDir, { recursive: true });

    writeFileSync(mockDocker, buildMockDockerScript(join(tempDir, "docker.log")), "utf8");
    chmodSync(mockDocker, 0o755);

    const result = runScript(BACKUP_SCRIPT, [outputFile], {
      BACKUP_DIR: backupDir,
      BACKUP_RETENTION_DAYS: "0",
      OFFSITE_URI: join(tempDir, "offsite"),
      REQUIRE_ENCRYPTED_OFFSITE: "true",
      PATH: `${mockBinDir}:${process.env.PATH || ""}`,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /define BACKUP_ENCRYPTION_PASSPHRASE/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-prune-backups fails when BACKUP_RETENTION_DAYS is invalid", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-prune-invalid-"));

  try {
    const result = runScript(PRUNE_SCRIPT, [], {
      BACKUP_DIR: tempDir,
      BACKUP_RETENTION_DAYS: "abc",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /BACKUP_RETENTION_DAYS invalido/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-prune-backups removes orphan checksum files", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-prune-orphan-"));
  const orphanChecksum = join(tempDir, "orphan.dump.sha256");

  try {
    writeFileSync(orphanChecksum, "deadbeef  orphan.dump\n", "utf8");

    const result = runScript(PRUNE_SCRIPT, [], {
      BACKUP_DIR: tempDir,
      BACKUP_RETENTION_DAYS: "14",
    });

    assert.equal(result.status, 0);
    assert.equal(existsSync(orphanChecksum), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-prune-backups deletes old dump and checksum files by retention", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-prune-old-"));
  const oldDump = join(tempDir, "old.dump");
  const oldChecksum = `${oldDump}.sha256`;
  const freshDump = join(tempDir, "fresh.dump");
  const freshChecksum = `${freshDump}.sha256`;

  try {
    writeFileSync(oldDump, "old backup\n", "utf8");
    writeFileSync(oldChecksum, "hash  old.dump\n", "utf8");
    writeFileSync(freshDump, "fresh backup\n", "utf8");
    writeFileSync(freshChecksum, "hash  fresh.dump\n", "utf8");

    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    utimesSync(oldDump, oldDate, oldDate);
    utimesSync(oldChecksum, oldDate, oldDate);

    const result = runScript(PRUNE_SCRIPT, [], {
      BACKUP_DIR: tempDir,
      BACKUP_RETENTION_DAYS: "2",
    });

    assert.equal(result.status, 0);
    assert.equal(existsSync(oldDump), false);
    assert.equal(existsSync(oldChecksum), false);
    assert.equal(existsSync(freshDump), true);
    assert.equal(existsSync(freshChecksum), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-restore fails when FORCE is not true", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-restore-force-"));
  const dumpFile = join(tempDir, "restore.dump");

  try {
    writeFileSync(dumpFile, "dummy dump\n", "utf8");

    const result = runScript(RESTORE_SCRIPT, [dumpFile], {
      FORCE: "false",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /restore bloqueado/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-restore fails with FORCE=true when input file does not exist", () => {
  const result = runScript(RESTORE_SCRIPT, ["/tmp/restore-does-not-exist.dump"], {
    FORCE: "true",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /archivo no encontrado/);
});

test("db-restore requires BACKUP_ENCRYPTION_PASSPHRASE for .enc backups", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-restore-enc-guard-"));
  const encryptedFile = join(tempDir, "restore.dump.enc");
  const checksumFile = `${encryptedFile}.sha256`;

  try {
    writeFileSync(encryptedFile, "encrypted payload\n", "utf8");

    const generate = spawnSync("sha256sum", [encryptedFile], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(generate.status, 0);
    const hash = String(generate.stdout || "").trim().split(" ")[0];
    writeFileSync(checksumFile, `${hash}  ${basename(encryptedFile)}\n`, "utf8");

    const result = runScript(RESTORE_SCRIPT, [encryptedFile], {
      FORCE: "true",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /define BACKUP_ENCRYPTION_PASSPHRASE/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-restore succeeds with FORCE=true using mocked docker compose flow", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-restore-positive-"));
  const dumpFile = join(tempDir, "restore.dump");
  const checksumFile = `${dumpFile}.sha256`;
  const mockBinDir = join(tempDir, "mock-bin");
  const mockDocker = join(mockBinDir, "docker");
  const dockerLog = join(tempDir, "docker.log");

  try {
    mkdirSync(mockBinDir, { recursive: true });
    writeFileSync(dumpFile, "mock restore payload\n", "utf8");

    const generate = spawnSync("sha256sum", [dumpFile], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(generate.status, 0);
    const hash = String(generate.stdout || "").trim().split(" ")[0];
    writeFileSync(checksumFile, `${hash}  ${basename(dumpFile)}\n`, "utf8");

    writeFileSync(mockDocker, buildMockDockerScript(dockerLog), "utf8");
    chmodSync(mockDocker, 0o755);

    const result = runScript(RESTORE_SCRIPT, [dumpFile], {
      FORCE: "true",
      PATH: `${mockBinDir}:${process.env.PATH || ""}`,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /ok: restore completado/);

    const logBody = readFileSync(dockerLog, "utf8");
    assert.match(logBody, /compose cp/);
    assert.match(logBody, /pg_restore/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-restore supports encrypted .enc backups with passphrase", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-restore-enc-positive-"));
  const encryptedFile = join(tempDir, "restore.dump.enc");
  const checksumFile = `${encryptedFile}.sha256`;
  const mockBinDir = join(tempDir, "mock-bin");
  const mockDocker = join(mockBinDir, "docker");
  const mockOpenSsl = join(mockBinDir, "openssl");
  const dockerLog = join(tempDir, "docker.log");

  try {
    mkdirSync(mockBinDir, { recursive: true });
    writeFileSync(encryptedFile, "encrypted payload\n", "utf8");

    const generate = spawnSync("sha256sum", [encryptedFile], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(generate.status, 0);
    const hash = String(generate.stdout || "").trim().split(" ")[0];
    writeFileSync(checksumFile, `${hash}  ${basename(encryptedFile)}\n`, "utf8");

    writeFileSync(mockDocker, buildMockDockerScript(dockerLog), "utf8");
    chmodSync(mockDocker, 0o755);

    writeFileSync(mockOpenSsl, buildMockOpenSslScript(), "utf8");
    chmodSync(mockOpenSsl, 0o755);

    const result = runScript(RESTORE_SCRIPT, [encryptedFile], {
      FORCE: "true",
      BACKUP_ENCRYPTION_PASSPHRASE: "secret-pass",
      PATH: `${mockBinDir}:${process.env.PATH || ""}`,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /ok: restore completado/);

    const logBody = readFileSync(dockerLog, "utf8");
    assert.match(logBody, /compose cp/);
    assert.match(logBody, /pg_restore/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("db-drill succeeds using mocked docker compose flow", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "consenthub-db-drill-positive-"));
  const workDir = join(tempDir, "work");
  const mockBinDir = join(tempDir, "mock-bin");
  const mockDocker = join(mockBinDir, "docker");
  const dockerLog = join(tempDir, "docker.log");

  try {
    mkdirSync(workDir, { recursive: true });
    mkdirSync(mockBinDir, { recursive: true });

    writeFileSync(mockDocker, buildMockDockerScript(dockerLog), "utf8");
    chmodSync(mockDocker, 0o755);

    const result = runScript(DRILL_SCRIPT, [], {
      WORK_DIR: workDir,
      PATH: `${mockBinDir}:${process.env.PATH || ""}`,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /ok: drill backup\/restore completado/);

    const files = spawnSync("bash", ["-lc", `ls -1 ${JSON.stringify(workDir)}`], {
      encoding: "utf8",
    });
    assert.equal(files.status, 0);
    assert.match(files.stdout, /drill-.*\.dump/);
    assert.match(files.stdout, /drill-.*\.dump\.sha256/);

    const logBody = readFileSync(dockerLog, "utf8");
    assert.match(logBody, /pg_dump/);
    assert.match(logBody, /compose cp/);
    assert.match(logBody, /psql/);
    assert.match(logBody, /pg_restore/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backup security policy fails when strict mode is disabled", () => {
  const result = runScript(POLICY_SCRIPT, [], {
    STRICT_BACKUP_SECRETS: "false",
    REQUIRE_ENCRYPTED_OFFSITE: "true",
    BACKUP_ENCRYPTION_PASSPHRASE: "super-strong-pass-123",
    BACKUP_ENCRYPTION_KEY_ID: "key-v1",
    BACKUP_ENCRYPTION_KEY_ROTATED_AT: "2026-04-01T00:00:00Z",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /STRICT_BACKUP_SECRETS debe estar en true/);
});

test("backup security policy fails when key rotation date is too old", () => {
  const result = runScript(POLICY_SCRIPT, [], {
    STRICT_BACKUP_SECRETS: "true",
    REQUIRE_ENCRYPTED_OFFSITE: "true",
    BACKUP_ENCRYPTION_PASSPHRASE: "super-strong-pass-123",
    BACKUP_ENCRYPTION_KEY_ID: "key-v1",
    BACKUP_ENCRYPTION_KEY_ROTATED_AT: "2000-01-01T00:00:00Z",
    BACKUP_KEY_MAX_AGE_DAYS: "90",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /fuera de ventana de rotacion/);
});

test("backup security policy succeeds with valid strict configuration", () => {
  const result = runScript(POLICY_SCRIPT, [], {
    STRICT_BACKUP_SECRETS: "true",
    REQUIRE_ENCRYPTED_OFFSITE: "true",
    BACKUP_ENCRYPTION_PASSPHRASE: "super-strong-pass-123",
    BACKUP_ENCRYPTION_KEY_ID: "key-v1",
    BACKUP_ENCRYPTION_KEY_ROTATED_AT: "2026-04-01T00:00:00Z",
    BACKUP_KEY_MAX_AGE_DAYS: "120",
    OFFSITE_URI: "s3://consenthub-backups/test",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout + result.stderr, /policy backup\/secretos valida/);
});
