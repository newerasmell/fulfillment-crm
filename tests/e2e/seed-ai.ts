// Synthetic data for the AI e2e (tests/e2e/ai.spec.ts). A separate group with its own OWNER. Nothing calls
// Anthropic: the reviewer runs here, in the seed process, against a MOCKED Messages API transport; the web server
// under test has no ANTHROPIC_API_KEY, so the UI shows the AI as off while the seeded suggestions are visible.
//   #AI-8001  BG, missing zip (hard finding) → AI: EDIT_AND_APPROVE zip → 1000 (address_fix at L1: one click)
//   #AI-8002  BG, clean (READY)               → AI: APPROVE 97 %
//   #AI-8003  an autopilot approval of yesterday → daily audit sample
//   #AI-81x0  five HU orders whose phone an operator changed 06… → +36… → rule proposal
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import { saveCredential } from "@/server/security/credentials";
import { setLlmClientForTests } from "@/ai/llm";
import { drawAuditSample } from "@/ai/evaluate";
import { ADDRESS_FIX_DECISION, AI_APPROVAL_DECISION, setPolicyEnabled } from "@/ai/policies";
import { reviewOrder } from "@/ai/reviewer";
import { mineRules } from "@/ai/rule-mining";
import { embedPendingReviews } from "@/ai/retrieval";
import { checkedOrder, mockLlm } from "@/ai/test-fixtures";
import { autopilotSuggestionData } from "@/ai/test-helpers";

export const AI_PASSWORD = "e2e-ai-password-not-secret";

export async function seedAi() {
  const owner = await bootstrapOwner({
    email: "e2e-ai@example.com",
    name: "E2E AI Owner",
    accountName: "Тест група AI",
    password: AI_PASSWORD,
  });
  const accountId = owner.account.id;
  const actor = { userId: owner.user.id, accountId, role: "OWNER" as const, companyScope: null };
  const company = await systemDb().company.findFirstOrThrow({ where: { accountId } });
  const db = accountDb(accountId);
  const cred = await saveCredential(db, accountId, { label: "eu", secret: "e2e-ai-eu-token-not-real" });
  const connection = await db.fulfillmentConnection.create({
    data: {
      accountId,
      companyId: company.id,
      type: "EUSHIPMENTS",
      name: "euShipments AI тест",
      credentialId: cred.id,
      vendorIds: { companyId: 333 },
      liveMode: "DRY_RUN",
    },
  });
  const store = await db.store.create({
    data: {
      accountId,
      companyId: company.id,
      domain: "e2e-ai.example",
      code: "AI",
      name: "AI магазин",
      currency: "EUR",
    },
  });
  await db.countrySetting.create({ data: { accountId, country: "BG", currency: "EUR" } });
  const g = { accountId, owner: actor, company, connection, store, db };

  await setPolicyEnabled(actor, AI_APPROVAL_DECISION, true);
  await setPolicyEnabled(actor, ADDRESS_FIX_DECISION, true);
  // Seed shortcut: address fixes start at L1 (assist) so the one-click apply can be tested; recorded as an event.
  const fixPolicy = await db.aiPolicy.update({
    where: { accountId_decisionType: { accountId, decisionType: ADDRESS_FIX_DECISION } },
    data: { level: "L1" },
  });
  await db.aiPolicyEvent.create({
    data: {
      accountId,
      policyId: fixPolicy.id,
      decisionType: ADDRESS_FIX_DECISION,
      fromLevel: "L0",
      toLevel: "L1",
      cause: "seed",
    },
  });

  setLlmClientForTests(
    mockLlm((body) =>
      JSON.stringify(body).includes("order.address.zip_missing")
        ? {
            decision: "EDIT_AND_APPROVE",
            confidence: 0.88,
            fixes: [
              { field: "shippingAddress.zip", from: null, to: "1000", reason: "Пощенски код на София" },
            ],
            flags: [],
            explanation_bg: "Липсва пощенски код; за София е 1000.",
          }
        : {
            decision: "APPROVE",
            confidence: 0.97,
            fixes: [],
            flags: [],
            explanation_bg: "Чиста поръчка — адресът и телефонът са валидни.",
          },
    ).client,
  );
  try {
    const fix = await checkedOrder(g, "#AI-8001", { missingZip: true });
    await reviewOrder(accountId, fix.id);
    const clean = await checkedOrder(g, "#AI-8002");
    await reviewOrder(accountId, clean.id);
  } finally {
    setLlmClientForTests(null);
  }

  // 300 compared, agreeing order-approval decisions: the promotion rule holds for L0 → L1.
  const history = await checkedOrder(g, "#AI-8000");
  await db.aiSuggestion.createMany({
    data: Array.from({ length: 300 }, () =>
      autopilotSuggestionData(accountId, history.id, {
        evaluatedAt: new Date(),
        decisionAgreed: true,
        fixesAgreed: true,
      }),
    ),
  });

  // An autopilot approval of yesterday → today's audit sample.
  const auto = await checkedOrder(g, "#AI-8003");
  await db.aiSuggestion.create({
    data: {
      ...autopilotSuggestionData(accountId, auto.id),
      explanationBg: "Автопилот: чиста поръчка, обичаен клиент.",
      autoApprovedAt: new Date(Date.now() - 86_400_000),
    },
  });
  await drawAuditSample(accountId);

  // Five HU orders where the operator turned 06… into +36… → one validator proposal.
  for (let i = 0; i < 5; i++) {
    const o = await checkedOrder(g, `#AI-81${i}0`);
    await db.order.update({ where: { id: o.id }, data: { countryCode: "HU" } });
    await db.review.create({
      data: {
        accountId,
        orderId: o.id,
        decision: "EDIT_AND_APPROVE",
        decidedAt: new Date(),
        reviewerId: owner.user.id,
        diff: [{ field: "phone", from: `0630${2000000 + i}`, to: `+3630${2000000 + i}`, via: "manual" }],
      },
    });
  }
  await mineRules(accountId);
  await embedPendingReviews(accountId);
  return { email: owner.user.email, password: AI_PASSWORD, totp: owner.totpSecret };
}
