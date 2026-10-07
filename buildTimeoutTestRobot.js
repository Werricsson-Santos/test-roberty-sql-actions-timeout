// Generates the importable robot (array of actions) that exercises the SQL timeouts on every engine.
const fs = require("fs");

// Usage (from this folder): node buildTimeoutTestRobot.js robo-teste-timeouts.json
const OUTPUT = process.argv[2] ?? "robo-teste-timeouts.json";
const PASSWORD = "Roberty_Test_123";
const BLACKHOLE = "10.255.255.1";
const SLOW_SECONDS = 6;
const CONNECTION_DEFAULT = 3;

const engines = [
  {
    key: "my",
    name: "MySQL",
    type: "MYSQL",
    versions: { connection: "v2_0_0", query: "v2_0_0", close: "v1_0_0" },
    connectionSettings: (host) => ({
      connectionString: text(`mysql://root:${PASSWORD}@${host}:${host === BLACKHOLE ? 3306 : 13306}/roberty_test`),
    }),
    fast: "SELECT 1 AS ok",
    slow: `SELECT SLEEP(${SLOW_SECONDS}) AS dormiu`,
    survivesTimeout: true,
  },
  {
    key: "pg",
    name: "PostgreSQL",
    type: "POSTGRESQL",
    versions: { connection: "v1_0_0", query: "v1_0_0", close: "v1_0_0" },
    connectionSettings: (host) => ({
      connectionString: text(`postgresql://postgres:${PASSWORD}@${host}:${host === BLACKHOLE ? 5432 : 15432}/roberty_test`),
    }),
    fast: "SELECT 1 AS ok",
    slow: `SELECT pg_sleep(${SLOW_SECONDS})`,
    survivesTimeout: true,
  },
  {
    key: "ms",
    name: "SQL Server",
    type: "SQLSERVER",
    versions: { connection: "v1_0_0", query: "v1_0_0", close: "v1_0_0" },
    connectionSettings: (host) => ({
      connectionString: text(`Server=${host},${host === BLACKHOLE ? 1433 : 11433};User Id=sa;Password=${PASSWORD};Encrypt=true;TrustServerCertificate=true`),
    }),
    fast: "SELECT 1 AS ok",
    slow: `WAITFOR DELAY '00:00:0${SLOW_SECONDS}'`,
    survivesTimeout: true,
  },
  {
    key: "or",
    name: "Oracle",
    type: "ORACLE",
    versions: { connection: "v1_0_0", query: "v1_0_0", close: "v1_0_0" },
    connectionSettings: (host) => ({
      user: text("roberty_test"),
      password: { type: "password", value: PASSWORD },
      connectString: text(`${host}:${host === BLACKHOLE ? 1521 : 11521}/FREEPDB1`),
    }),
    fast: "SELECT 1 AS ok FROM dual",
    slow: `BEGIN DBMS_SESSION.SLEEP(${SLOW_SECONDS}); END;`,
    survivesTimeout: true,
  },
  {
    key: "fb",
    name: "Firebird",
    type: "FIREBIRD",
    versions: { connection: "v1_0_0", query: "v1_0_0", close: "v1_0_0" },
    connectionSettings: (host) => ({
      connectionType: "remoteHost",
      host: text(host),
      port: { type: "number", value: host === BLACKHOLE ? "3050" : "13050" },
      database: text("/var/lib/firebird/data/roberty_test.fdb"),
      user: text("roberty_test"),
      password: { type: "password", value: PASSWORD },
    }),
    fast: "SELECT 1 AS ok FROM rdb$database",
    // Firebird has no sleep function: busy loop until the deadline ('NOW' is re-evaluated, CURRENT_TIMESTAMP is not)
    slow: `EXECUTE BLOCK RETURNS (ok INTEGER) AS DECLARE fim TIMESTAMP; BEGIN fim = DATEADD(${SLOW_SECONDS} SECOND TO CAST('NOW' AS TIMESTAMP)); WHILE (CAST('NOW' AS TIMESTAMP) < fim) DO ok = 0; ok = 1; SUSPEND; END`,
    survivesTimeout: false,
  },
];

function text(value) {
  return { type: "text", value };
}

const actions = [];

const add = (action) => {
  actions.push({ disabled: false, selected: false, ...action });
  return action.id;
};

const baseSettings = (id, alias, extra) => ({
  id,
  alias,
  ...extra,
  stopRobotIfError: true,
  numberOfAttempts: 1,
  version: extra.version ?? "v1_0_0",
});

/** Links ids as one branch: first has no prev, last has no next */
const chain = (parent, ids) => {
  ids.forEach((id, index) => {
    const action = actions.find((a) => a.id === id);
    if (parent) action.parent = parent;
    if (index > 0) action.prev = ids[index - 1];
    if (index < ids.length - 1) action.next = ids[index + 1];
  });
  return ids[0];
};

const log = (id, codeBody, stopRobotIfError = true) => add({
  id,
  type: "UTILS_SHOW_IN_HISTORY",
  settings: { ...baseSettings(id, id, {}), code: { type: "code", value: codeBody }, stopRobotIfError },
});

const startClock = (id) => add({
  id,
  type: "UTILS_CUSTOM_CODE",
  settings: { ...baseSettings(id, id, {}), code: "return Date.now()", varsToGenerate: ["value"] },
});

const elapsed = (clockId) => `((Date.now() - actions.${clockId}.value) / 1000).toFixed(1)`;

const tryCatch = (id, tryIds, catchIds) => {
  add({
    id,
    type: "Designer:tryCatch",
    minimized: false,
    settings: { ...baseSettings(id, id, {}), attempts: 1 },
  });
  const action = actions.find((a) => a.id === id);
  action.tryEntrypoint = chain(id, tryIds);
  action.catchEntrypoint = chain(id, catchIds);
  return id;
};

const section = (id, name, childIds) => {
  add({ id, type: "Designer:section", minimized: false, settings: { ...baseSettings(id, id, {}), name } });
  actions.find((a) => a.id === id).entrypoint = chain(id, childIds);
  return id;
};

const buildEngine = (engine) => {
  const k = engine.key;
  const tag = engine.name;
  const t = (suffix) => `${k}${suffix}`;
  const type = (action) => `DATABASE_${engine.type}_${action}`;

  const connection = (id, host, timeouts) => add({
    id,
    type: type("CONNECTION"),
    settings: { ...baseSettings(id, id, { version: engine.versions.connection }), ...engine.connectionSettings(host), ...timeouts, varsToGenerate: [] },
  });

  const query = (id, connectionId, sql, timeout) => add({
    id,
    type: type("QUERY"),
    settings: {
      ...baseSettings(id, id, { version: engine.versions.query }),
      connection: connectionId,
      query: { type: "longText", value: sql },
      ...(timeout === undefined ? {} : { timeout }),
    },
  });

  const close = (id, connectionId, stopRobotIfError = true) => add({
    id,
    type: type("CLOSE"),
    settings: { ...baseSettings(id, id, { version: engine.versions.close }), connection: connectionId, stopRobotIfError },
  });

  const ok = (label) => `✅ [${tag}] ${label}`;
  const fail = (label) => `❌ [${tag}] ${label}`;
  const conn = t("Conexao");

  /** Scenario expected to succeed */
  const expectSuccess = (name, label, steps) => {
    const clock = startClock(t(`${name}Inicio`));
    return tryCatch(
      t(`${name}Teste`),
      [clock, ...steps(), log(t(`${name}Ok`), `return \`${ok(label)} em \${${elapsed(clock)}}s\``)],
      [log(t(`${name}Erro`), `return \`${fail(label)}: \${actions.${t(`${name}Teste`)}.message}\``, false)],
    );
  };

  /** Scenario expected to hit a time limit around `expectedSeconds` */
  const expectTimeout = (name, label, expectedSeconds, steps, extraCatch = []) => {
    const clock = startClock(t(`${name}Inicio`));
    const tryId = t(`${name}Teste`);
    const verdict = [
      `const segundos = Number(${elapsed(clock)})`,
      `const mensagem = String(actions.${tryId}.message)`,
      `const noTempo = segundos < ${expectedSeconds} + 2`,
      `const ehTimeout = mensagem.includes("exceeded the time limit")`,
      `return (ehTimeout && noTempo ? \`${ok(label)} em \${segundos}s\` : \`${fail(label)}: \${segundos}s, "\${mensagem}"\`)`,
    ].join("\n");
    return tryCatch(
      tryId,
      [clock, ...steps(), log(t(`${name}NaoEstourou`), `return \`${fail(label)}: não estourou (\${${elapsed(clock)}}s)\``)],
      [log(t(`${name}Veredito`), verdict, false), ...extraCatch],
    );
  };

  const scenarios = [
    expectSuccess("Conectar", `conectou (padrão das consultas: ${CONNECTION_DEFAULT}s)`, () => [
      connection(conn, "localhost", { connectTimeout: 10, queryTimeout: CONNECTION_DEFAULT }),
    ]),
    expectSuccess("Rapida", "consulta rápida herdando o padrão da conexão", () => [
      query(t("RapidaQuery"), conn, engine.fast),
    ]),
    expectSuccess("Maior", `consulta de ${SLOW_SECONDS}s com limite próprio de 15s (maior que o padrão)`, () => [
      query(t("MaiorQuery"), conn, engine.slow, 15),
    ]),
    expectSuccess("Zero", `consulta de ${SLOW_SECONDS}s com limite 0 (sem limite)`, () => [
      query(t("ZeroQuery"), conn, engine.slow, 0),
    ]),
    expectTimeout("Padrao", `consulta de ${SLOW_SECONDS}s parou no padrão da conexão (${CONNECTION_DEFAULT}s)`, CONNECTION_DEFAULT, () => [
      query(t("PadraoQuery"), conn, engine.slow),
    ]),
    engine.survivesTimeout
      ? expectSuccess("Depois", "conexão continua utilizável depois do timeout", () => [
        query(t("DepoisQuery"), conn, engine.fast, 10),
      ])
      : tryCatch(
        t("DepoisTeste"),
        [query(t("DepoisQuery"), conn, engine.fast, 10), log(t("DepoisErro"), `return \`${fail("a conexão deveria ter sido encerrada após o timeout")}\``)],
        [log(t("DepoisOk"), `return \`${ok("conexão encerrada após o timeout, como esperado (Firebird não cancela consulta)")}\``, false)],
      ),
    expectTimeout("Menor", "consulta parou no limite próprio de 1s (menor que o padrão de 30s)", 1, () => [
      connection(t("Conexao2"), "localhost", { connectTimeout: 10, queryTimeout: 30 }),
      query(t("MenorQuery"), t("Conexao2"), engine.slow, 1),
    ], [close(t("Fechar2"), t("Conexao2"), false)]),
    (() => {
      const clock = startClock(t("InalcancavelInicio"));
      const tryId = t("InalcancavelTeste");
      const label = `desistiu de conectar em ${BLACKHOLE} (limite de 3s)`;
      return tryCatch(
        tryId,
        [clock, connection(t("ConexaoInalcancavel"), BLACKHOLE, { connectTimeout: 3 }), log(t("InalcancavelErro"), `return \`${fail(`conectou em ${BLACKHOLE}?!`)}\``)],
        [log(t("InalcancavelVeredito"), [
          `const segundos = Number(${elapsed(clock)})`,
          `return (segundos < 5 ? \`${ok(label)} em \${segundos}s\` : \`${fail(label)}: levou \${segundos}s, "\${actions.${tryId}.message}"\`)`,
        ].join("\n"), false)],
      );
    })(),
    // On Firebird the connection was already dropped by the timeout: closing it must return at once, not hang
    expectSuccess("Fechar", engine.survivesTimeout ? "conexão fechada" : "fechar a conexão já encerrada não travou", () => [close(t("FecharConexao"), conn)]),
  ];

  return section(t("Secao"), `${engine.name} - teste de tempo limite`, scenarios);
};

const intro = log("inicio", `return "Teste de tempo limite SQL: procure ❌ no histórico. Bancos de docker/databases (roberty-actions)."`, false);
const sections = engines.map(buildEngine);
const done = log("fim", `return "Fim dos testes de tempo limite SQL"`, false);

add({ id: "entrypoint", type: "Designer:entrypoint" });
add({ id: "endpoint", type: "Designer:endpoint" });
const rootIds = [intro, ...sections, done];
chain(undefined, rootIds);
actions.find((a) => a.id === "entrypoint").next = rootIds[0];
actions.find((a) => a.id === rootIds[0]).prev = "entrypoint";
actions.find((a) => a.id === rootIds[rootIds.length - 1]).next = "endpoint";
actions.find((a) => a.id === "endpoint").prev = rootIds[rootIds.length - 1];

const ids = new Set();
for (const action of actions) {
  if (ids.has(action.id)) throw new Error(`duplicated id ${action.id}`);
  ids.add(action.id);
}
for (const action of actions) {
  for (const ref of ["prev", "next", "parent", "entrypoint", "tryEntrypoint", "catchEntrypoint"]) {
    if (action[ref] && !ids.has(action[ref])) throw new Error(`${action.id}.${ref} -> missing ${action[ref]}`);
  }
}

fs.writeFileSync(OUTPUT, JSON.stringify(actions, null, 2) + "\n");
console.log(`${actions.length} actions -> ${OUTPUT}`);
