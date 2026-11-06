import { describe, expect, it } from "vitest";
import { bootstrapOwner } from "@/server/auth/users";
import { orderDesignOf, setOrderDesign } from "./preferences";

describe("personal order page design (database)", () => {
  it("defaults to new, saves classic per person, refuses anything else", async () => {
    const a = await bootstrapOwner({
      email: `pref-a-${Date.now()}@example.com`,
      name: "A",
      accountName: "Pref A",
      password: "correct horse battery staple",
    });
    const b = await bootstrapOwner({
      email: `pref-b-${Date.now()}@example.com`,
      name: "B",
      accountName: "Pref B",
      password: "correct horse battery staple",
    });
    expect(await orderDesignOf(a.user.id)).toBe("new");
    await setOrderDesign(a.user.id, "classic");
    expect(await orderDesignOf(a.user.id)).toBe("classic");
    expect(await orderDesignOf(b.user.id)).toBe("new");
    await expect(setOrderDesign(a.user.id, "retro")).rejects.toThrow();
    await setOrderDesign(a.user.id, "new");
    expect(await orderDesignOf(a.user.id)).toBe("new");
  });
});
