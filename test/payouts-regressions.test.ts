import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";
import { reaisFromCents } from "../src/money.ts";

type App = ReturnType<typeof createApp>;

function setup(): App {
  const db = openDatabase(":memory:");
  seedIncident(db);
  return createApp(db);
}

async function postJson(app: App, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function approve(app: App, missionId: string, approvedAt: string, key: string): Promise<Response> {
  return postJson(app, "/approvals", {
    mission_id: missionId,
    approved_at: approvedAt,
    idempotency_key: key,
  });
}

async function missionLedger(app: App, missionId: string): Promise<Array<{ id: string }>> {
  const response = await app.request(`/missions/${missionId}`);
  const body = (await response.json()) as { ledger: Array<{ id: string }> };
  return body.ledger;
}

describe("regressões de repasse", () => {
  it("usa a data civil de São Paulo, incluindo o último instante do prazo", async () => {
    const utcMidnight = setup();
    expect((await approve(utcMidnight, "msn_1842", "2026-03-13T01:02:00.000Z", "pay_utc")).status).toBe(201);

    const firstInstant = setup();
    expect((await approve(firstInstant, "msn_1842", "2026-03-12T03:00:00.000Z", "pay_midnight")).status).toBe(201);

    const lastInstant = setup();
    expect(
      (await approve(lastInstant, "msn_1842", "2026-03-13T02:59:59.999Z", "pay_last")).status,
    ).toBe(201);

    const nextDay = setup();
    expect((await approve(nextDay, "msn_1842", "2026-03-13T03:00:00.000Z", "pay_next")).status).toBe(409);

    const explicitOffset = setup();
    expect(
      (await approve(explicitOffset, "msn_1842", "2026-03-13T05:02:00.000+04:00", "pay_offset")).status,
    ).toBe(201);
  });

  it("converte centavos em reais uma única vez", () => {
    expect(reaisFromCents(0)).toBe(0);
    expect(reaisFromCents(1)).toBe(0.01);
    expect(reaisFromCents(99)).toBe(0.99);
    expect(reaisFromCents(100)).toBe(1);
    expect(reaisFromCents(8000)).toBe(80);
    expect(reaisFromCents(15000)).toBe(150);
  });

  it.each([
    { label: "espaço final", key: "pay_22a", replayKey: "pay_22a " },
    { label: "zero-width space", key: "pay_7c1", replayKey: "pay_7c1\u200B" },
  ])("reusa o crédito para uma chave com $label", async ({ key, replayKey }) => {
    const app = setup();
    expect((await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", key)).status).toBe(201);
    expect((await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", replayKey)).status).toBe(200);
    expect(await missionLedger(app, "msn_1900")).toHaveLength(1);
  });

  it("recusa uma chave que fica vazia após canonicalização", async () => {
    const app = setup();
    expect((await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", " \u200B ")).status).toBe(400);
    expect(await missionLedger(app, "msn_1900")).toHaveLength(0);
  });

  it("não credita uma missão novamente com uma chave diferente", async () => {
    const app = setup();
    expect((await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", "pay_first")).status).toBe(201);
    expect((await approve(app, "msn_1900", "2026-03-12T18:12:00.000Z", "pay_second")).status).toBe(409);
    expect(await missionLedger(app, "msn_1900")).toHaveLength(1);
  });

  it("reabre uma base legada com créditos duplicados sem apagar nem criar outro", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conty-legacy-ledger-"));
    const databasePath = join(directory, "repasses.sqlite");

    try {
      const legacy = openDatabase(databasePath);
      try {
        seedIncident(legacy);
        const insert = legacy.prepare(
          "INSERT INTO ledger (id, mission_id, idempotency_key, amount_brl, created_at) VALUES (?, ?, ?, ?, ?)",
        );
        insert.run("legacy_ledger_1", "msn_1900", "legacy_key_1", 150, "2026-03-12T18:11:01.000Z");
        insert.run("legacy_ledger_2", "msn_1900", "legacy_key_2", 150, "2026-03-12T18:11:02.000Z");
        legacy.prepare("UPDATE missions SET status = 'approved' WHERE id = ?").run("msn_1900");
      } finally {
        legacy.close();
      }

      const reopened = openDatabase(databasePath);
      try {
        const app = createApp(reopened);
        expect(await missionLedger(app, "msn_1900")).toHaveLength(2);
        expect((await approve(app, "msn_1900", "2026-03-12T18:12:00.000Z", "legacy_new_key")).status).toBe(409);
        expect(await missionLedger(app, "msn_1900")).toHaveLength(2);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejeita a mesma chave usada por outra missão", async () => {
    const app = setup();
    expect((await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", "pay_shared")).status).toBe(201);
    const conflict = await approve(app, "msn_2044", "2026-03-20T15:00:00.000Z", "pay_shared");
    expect(conflict.status).toBe(409);
    const body = await conflict.json();
    expect(body).toHaveProperty("error");
    expect(body).not.toHaveProperty("ledger");
    expect(await missionLedger(app, "msn_1900")).toHaveLength(1);
    expect(await missionLedger(app, "msn_2044")).toHaveLength(0);
  });

  it("reverte o crédito quando o insert do payout falha e permite tentar de novo", async () => {
    const db = openDatabase(":memory:");
    seedIncident(db);
    const before = db.prepare("SELECT * FROM missions WHERE id = ?").get("msn_1900");
    db.exec(`
      CREATE TEMP TRIGGER fail_payout BEFORE INSERT ON payouts
      BEGIN
        SELECT RAISE(ABORT, 'forced payout failure');
      END;
    `);
    const app = createApp(db);
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", "pay_atomic");
      expect(failed.status).toBe(500);
      expect(db.prepare("SELECT COUNT(*) AS n FROM ledger").get()?.n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM payouts").get()?.n).toBe(0);
      expect(db.prepare("SELECT * FROM missions WHERE id = ?").get("msn_1900")).toEqual(before);

      db.exec("DROP TRIGGER fail_payout");
      const retry = await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", "pay_atomic");
      expect(retry.status).toBe(201);
      expect(db.prepare("SELECT COUNT(*) AS n FROM ledger").get()?.n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM payouts").get()?.n).toBe(1);
    } finally {
      expectedError.mockRestore();
      db.close();
    }
  });

  it("reproduz o resultado existente antes de validar um novo prazo expirado", async () => {
    const app = setup();
    const first = await approve(app, "msn_1842", "2026-03-13T02:59:59.999Z", "pay_replay");
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { ledger: { id: string } };

    const replay = await approve(app, "msn_1842", "2026-03-13T03:00:00.000Z", "pay_replay");
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { ledger: { id: string } };
    expect(replayBody.ledger.id).toBe(firstBody.ledger.id);
    expect(await missionLedger(app, "msn_1842")).toHaveLength(1);
  });

  it("mapeia CONFIRMED como pago e rejeita um status desconhecido", async () => {
    const app = setup();
    const approval = await approve(app, "msn_2044", "2026-03-20T15:00:00.000Z", "pay_provider");
    const approvalBody = (await approval.json()) as { payout: { id: string } };

    const pending = await postJson(app, `/payouts/${approvalBody.payout.id}/provider`, {
      provider_status: "PENDING",
    });
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as { status: string }).status).toBe("pending");

    const confirmed = await postJson(app, `/payouts/${approvalBody.payout.id}/provider`, {
      provider_status: "CONFIRMED",
    });
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as { status: string }).status).toBe("paid");

    const unknown = await postJson(app, `/payouts/${approvalBody.payout.id}/provider`, {
      provider_status: "UNKNOWN",
    });
    expect(unknown.status).toBe(400);
  });
});
