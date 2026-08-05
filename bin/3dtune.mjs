const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

if (!Number.isFinite(major) || major < 24) {
  process.stderr.write(
    `3DTune requires Node.js 24 or newer; current version is ${process.versions.node}.\n` +
      'Install a current Node.js LTS release and try again.\n',
  );
  process.exitCode = 1;
} else {
  let terminating = false;
  const fatal = (kind, error) => {
    if (terminating) return;
    terminating = true;
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`3DTune ${kind}: ${message}\n`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 50);
  };

  process.on('uncaughtException', (error) => fatal('uncaught exception', error));
  process.on('unhandledRejection', (reason) => fatal('unhandled rejection', reason));

  try {
    await import('../src/index.ts');
  } catch (error) {
    fatal('startup failed', error);
  }
}
