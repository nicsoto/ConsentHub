function write(level, payload) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    ...payload,
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

function info(payload) {
  write("info", payload);
}

function error(payload) {
  write("error", payload);
}

module.exports = {
  info,
  error,
};
