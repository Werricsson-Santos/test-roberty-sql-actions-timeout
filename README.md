# Bancos de teste das actions de database

Containers descartáveis para testar as actions SQL (`src/actions/database`) contra bancos reais, principalmente tempo limite e cancelamento de consultas. Use só credenciais de teste. Nada aqui deve apontar para dados reais.

| Engine | Imagem | Porta local | Usuário / banco |
|---|---|---|---|
| MySQL 8 | `mysql:8.0` | 13306 | `root` / `roberty_test` |
| PostgreSQL 16 | `postgres:16` | 15432 | `postgres` / `roberty_test` |
| SQL Server 2022 | `mcr.microsoft.com/mssql/server:2022-latest` | 11433 | `sa` |
| Oracle 23 Free | `gvenzl/oracle-free:23-slim-faststart` | 11521 | `roberty_test` / serviço `FREEPDB1` |
| Firebird 5 | `firebirdsql/firebird:5` | 13050 | `roberty_test` / `/var/lib/firebird/data/roberty_test.fdb` |

As portas fogem das padrão para não colidir com bancos que você já tenha rodando. A senha de todos é `Roberty_Test_123`. Senha, portas e host podem ser trocados pelas variáveis `ROBERTY_TEST_DB_PASSWORD`, `ROBERTY_TEST_<ENGINE>_PORT` e `ROBERTY_TEST_DB_HOST`, lidas tanto pelo compose quanto pelos testes.

## Subir e derrubar

```bash
cd docker/databases
docker compose up -d                 # todos
docker compose up -d postgres mysql  # só alguns
docker compose ps                    # espere "healthy" (o Oracle leva ~1 min na primeira vez)
docker compose down -v               # derruba e apaga os dados
```

## Rodar os testes

```bash
# sem banco (sempre rodam): regras de timeout e herança da conexão
yarn test src/tests/actions/database/timeouts.test.ts

# contra os containers
ROBERTY_DB_TESTS=1 yarn test src/tests/actions/database/timeouts.integration.test.ts
ROBERTY_DB_TESTS=1 ROBERTY_DB_TESTS_ONLY=postgresql,mysql yarn test src/tests/actions/database
```

No PowerShell, defina antes: `$env:ROBERTY_DB_TESTS = "1"`.

Para cada engine, a suíte de integração verifica que:

- a consulta para no tempo padrão da conexão, com um `DatabaseTimeoutError` claro;
- o tempo da própria consulta vale antes do padrão da conexão, tanto para mais quanto para menos;
- `0` significa sem limite;
- depois do timeout a conexão continua utilizável, porque a consulta é cancelada no servidor. A exceção é o Firebird: o driver não sabe cancelar, então a conexão é encerrada;
- conectar num host inalcançável desiste no tempo limite de conexão (usa `10.255.255.1`; em redes que respondem a esse endereço o teste não prova nada).

## Robô de teste (designer/studio + desktop)

`robo-teste-timeouts.json` é um fluxo pronto para importar (designer v4: Configurações → Importar/Exportar; studio v5: importar fluxo ou criar robô a partir de `.json`). **A importação substitui o fluxo inteiro**, então importe num robô de teste vazio.

Há uma seção (`Designer:section`) por banco: MySQL, PostgreSQL, SQL Server, Oracle e Firebird. Cada cenário fica num try/catch próprio, então um timeout esperado (ou um banco fora do ar) não interrompe os demais. Cada cenário escreve no histórico uma linha `✅`/`❌` com o tempo medido:

| # | Cenário | Esperado |
|---|---|---|
| 1 | Conectar com `connectTimeout` 10s e `queryTimeout` 3s | conecta |
| 2 | Consulta rápida, sem limite próprio | passa (herda 3s) |
| 3 | Consulta de 6s com limite próprio de 15s | passa: o limite da consulta vale mais que o padrão |
| 4 | Consulta de 6s com limite `0` | passa: sem limite |
| 5 | Consulta de 6s sem limite próprio | estoura em ~3s (padrão da conexão) |
| 6 | Consulta rápida na mesma conexão depois do timeout | passa; **no Firebird**, falha porque a conexão foi encerrada |
| 7 | Nova conexão com padrão de 30s e consulta de 6s com limite de 1s | estoura em ~1s |
| 8 | Conectar em `10.255.255.1` com `connectTimeout` 3s | falha em menos de 5s |
| 9 | Fechar a conexão | fecha; no Firebird, já encerrada no cenário 5, o fechamento retorna na hora em vez de travar |

Depois da execução, procure `❌` no histórico. As conexões usam `localhost` e as portas/senha padrão deste compose, então o desktop precisa rodar na mesma máquina dos containers. Se mudar portas ou senha, regenere o JSON com `node buildTimeoutTestRobot.js` (os valores ficam no topo do script). As credenciais ficam em texto no fluxo, o que só é aceitável porque são de teste.

## Consultas lentas para testar à mão (no designer/desktop)

| Engine | Consulta |
|---|---|
| MySQL | `SELECT SLEEP(10)` |
| PostgreSQL | `SELECT pg_sleep(10)` |
| SQL Server | `WAITFOR DELAY '00:00:10'` |
| Oracle | `BEGIN DBMS_SESSION.SLEEP(10); END;` |
| Firebird | `EXECUTE BLOCK RETURNS (ok INTEGER) AS DECLARE fim TIMESTAMP; BEGIN fim = DATEADD(10 SECOND TO CAST('NOW' AS TIMESTAMP)); WHILE (CAST('NOW' AS TIMESTAMP) < fim) DO ok = 0; ok = 1; SUSPEND; END` (Firebird não tem sleep) |

Para confirmar que o cancelamento chegou ao servidor, rode durante o teste: `SHOW PROCESSLIST` (MySQL), `SELECT * FROM pg_stat_activity` (PostgreSQL), `sp_who2` (SQL Server) ou `v$session` (Oracle).
