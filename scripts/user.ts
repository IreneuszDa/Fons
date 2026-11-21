/**
 * Zarządzanie użytkownikami panelu z wiersza poleceń (działa też, gdy serwer jest wyłączony).
 *
 *   npm run user -- add <login> <rola>     rola: moderator | analityk | administrator
 *   npm run user -- list
 *   npm run user -- remove <login>
 *   npm run user -- passwd <login>         zmiana hasła
 *
 * Hasło NIGDY nie jest argumentem polecenia (trafiłoby do historii powłoki i listy procesów):
 * w terminalu skrypt pyta o nie bez echa (dwa razy), a przy potoku czyta pierwszą linię ze standardowego wejścia:
 *   printf '%s\n' "$HASLO" | npm run user -- add anna moderator
 *
 * Zmiany trafiają do pliku użytkowników (USERS_PATH, domyślnie var/users.json). Uruchomiony serwer widzi je od razu.
 * Jeśli baza istnieje, zmiany są też zapisane w dzienniku działań administratorów (aktor „cli”).
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { createAdminLog } from "../src/server/auth/adminlog";
import { ROLES } from "../src/server/auth/permissions";
import { UserError, createUserStore } from "../src/server/auth/users";
import { resolveUsersPath } from "../src/server/config";
import { migrate } from "../src/server/db";

const USAGE = `Użycie:
  npm run user -- add <login> <rola>   (rola: ${ROLES.join(" | ")})
  npm run user -- list
  npm run user -- remove <login>
  npm run user -- passwd <login>
Hasło podajesz w odpowiedzi na pytanie albo przez standardowe wejście, nigdy w poleceniu.`;

function die(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Czyta jedną linię z terminala bez echa. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = "";
    // najpierw tryb surowy (brak echa), dopiero potem pytanie: nic wpisanego po pytaniu nie zostanie pokazane
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    process.stderr.write(question);
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

async function readPassword(confirm: boolean): Promise<string> {
  if (!process.stdin.isTTY) {
    const p = await readStdinLine();
    if (!p) die("Nie podano hasła na standardowym wejściu.");
    return p;
  }
  const first = await promptHidden("Hasło: ");
  if (confirm) {
    const second = await promptHidden("Powtórz hasło: ");
    if (first !== second) die("Hasła się różnią. Nic nie zmieniono.");
  }
  return first;
}

function openAudit() {
  const dbPath = process.env.DB_PATH?.trim() || "var/prawdowid.db";
  if (!existsSync(dbPath)) return undefined;
  try {
    const db = new Database(dbPath);
    db.pragma("busy_timeout = 3000");
    migrate(db);
    return { db, log: createAdminLog(db) };
  } catch {
    process.stderr.write("Uwaga: nie udało się zapisać zmiany w dzienniku działań (baza niedostępna).\n");
    return undefined;
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") die(USAGE, cmd ? 0 : 1);
  const store = createUserStore({ path: resolveUsersPath() });
  const audit = (action: string, target: string, detail?: string) => {
    const a = openAudit();
    if (!a) return;
    try {
      a.log.append({ actor: "cli", role: "system", action, target, detail });
    } finally {
      a.db.close();
    }
  };

  try {
    switch (cmd) {
      case "add": {
        const [username, role] = args;
        if (!username || !role || args.length !== 2) die(`Podaj login i rolę (bez hasła).\n${USAGE}`);
        const password = await readPassword(true);
        const u = await store.add({ username, role, password });
        audit("user.create", u.username, `role:${u.role}`);
        console.log(`Dodano użytkownika ${u.username} (${u.role}).`);
        break;
      }
      case "list": {
        const users = store.list();
        if (users.length === 0) console.log("Brak użytkowników. Pierwszy start serwera utworzy konto „admin”.");
        for (const u of users) console.log(`${u.username.padEnd(24)} ${u.role.padEnd(14)} ${u.createdAt}`);
        break;
      }
      case "remove": {
        const [username] = args;
        if (!username || args.length !== 1) die(`Podaj login.\n${USAGE}`);
        const u = store.remove(username);
        audit("user.delete", u.username, `role:${u.role}`);
        console.log(`Usunięto użytkownika ${u.username}.`);
        break;
      }
      case "passwd": {
        const [username] = args;
        if (!username || args.length !== 1) die(`Podaj login.\n${USAGE}`);
        if (!store.get(username)) die("Nie ma takiego użytkownika.");
        const password = await readPassword(true);
        await store.setPassword(username, password);
        audit("user.password", username.toLowerCase());
        console.log(`Zmieniono hasło użytkownika ${username.toLowerCase()}.`);
        break;
      }
      default:
        die(`Nieznane polecenie: ${cmd}\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof UserError) die(e.message);
    throw e;
  }
}

main().catch((e) => {
  process.stderr.write(`Błąd: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
