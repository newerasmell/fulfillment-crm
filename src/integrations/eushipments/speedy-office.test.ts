import { describe, expect, it } from "vitest";
import { matchSpeedyOffice, normaliseOfficeName, parseSpeedyOffice } from "./speedy-office";

// Public Speedy office names/addresses (owner's examples); synthetic office ids in the lists.
describe("parseSpeedyOffice", () => {
  const table: [string, number, string][] = [
    [
      "Office Speedy [864] АСЕНОВГРАД - ЗЪБЧЕТО: пл. Авксентий Велешки No 7, Асеновград, 4230, BG",
      864,
      "АСЕНОВГРАД - ЗЪБЧЕТО",
    ],
    [
      "Office Speedy [275] ПЛЕВЕН - САН СТЕФАНО (УЛ.): ул. Сан Стефано No 35, Плевен, 5800, BG",
      275,
      "ПЛЕВЕН - САН СТЕФАНО (УЛ.)",
    ],
    [
      "Office Speedy [247] ПЛЕВЕН - ХАДЖИ ДИМИТЪР (УЛ.): ул. Хаджи Димитър No 52, Плевен, 5800, BG",
      247,
      "ПЛЕВЕН - ХАДЖИ ДИМИТЪР (УЛ.)",
    ],
    [
      "Office Speedy [355] ПЛОВДИВ - КОМАТЕВО: ул. Обнова No 23, Пловдив, 4000, BG",
      355,
      "ПЛОВДИВ - КОМАТЕВО",
    ],
    [
      "Office Speedy [862] ПАЗАРДЖИК - ГЕНЕРАЛ ГУРКО: ул. Завоя на Черна No 7, Пазарджик, 4400, BG",
      862,
      "ПАЗАРДЖИК - ГЕНЕРАЛ ГУРКО",
    ],
  ];
  for (const [raw, id, name] of table)
    it(`${id} ${name}`, () => {
      expect(parseSpeedyOffice(raw)).toMatchObject({ speedyId: id, officeName: name });
    });
  it("an ordinary address is not an office", () => {
    expect(parseSpeedyOffice("ул. Витоша 15, София, 1000, BG")).toBeNull();
    expect(parseSpeedyOffice(null)).toBeNull();
  });
  it("extra spaces and lower case are fine", () => {
    expect(
      parseSpeedyOffice("  office   speedy  [ 355 ]   ПЛОВДИВ   -  КОМАТЕВО  :  ул. Обнова No 23, Пловдив"),
    ).toMatchObject({
      speedyId: 355,
      officeName: "ПЛОВДИВ - КОМАТЕВО",
      addressPart: "ул. Обнова No 23, Пловдив",
    });
  });
  it("no ':' → not an office (never guessed)", () => {
    expect(parseSpeedyOffice("Office Speedy [355] ПЛОВДИВ - КОМАТЕВО ул. Обнова 23")).toBeNull();
    expect(parseSpeedyOffice("Office Speedy ПЛОВДИВ - КОМАТЕВО: ул. Обнова 23")).toBeNull();
  });
});

describe("normaliseOfficeName", () => {
  it("case, spaces, dashes and Latin look-alikes", () => {
    expect(normaliseOfficeName("Пловдив  –  Коматево")).toBe("ПЛОВДИВ - КОМАТЕВО");
    // "P", "O", "A" typed in Latin inside a Cyrillic name.
    expect(normaliseOfficeName("ПЛOВДИВ - KOMATEВO")).toBe("ПЛОВДИВ - КОМАТЕВО");
    expect(normaliseOfficeName("Plovdiv - Center")).toBe("PLOVDIV - CENTER");
  });
});

describe("matchSpeedyOffice", () => {
  const parsed = parseSpeedyOffice(
    "Office Speedy [275] ПЛЕВЕН - САН СТЕФАНО (УЛ.): ул. Сан Стефано No 35, Плевен",
  )!;
  const a = { officeId: 9001, courierOfficeId: 275, name: "ПЛЕВЕН - САН СТЕФАНО (УЛ.)" };
  const b = { officeId: 9002, courierOfficeId: 247, name: "ПЛЕВЕН - ХАДЖИ ДИМИТЪР (УЛ.)" };
  it("by the Speedy id (and the name agrees)", () => {
    expect(matchSpeedyOffice(parsed, [a, b])).toEqual({ kind: "matched", office: a, by: "speedy_id" });
  });
  it("by the name when the list has no courier ids", () => {
    const noIds = [a, b].map((o) => ({ ...o, courierOfficeId: null }));
    expect(matchSpeedyOffice(parsed, noIds)).toEqual({ kind: "matched", office: noIds[0], by: "name" });
  });
  it("never chosen automatically: id and name disagree, two by name, none", () => {
    const wrongName = { ...a, name: "ДРУГ ОФИС" };
    expect(matchSpeedyOffice(parsed, [wrongName, b]).kind).toBe("ambiguous");
    const twin = { ...a, officeId: 9003, courierOfficeId: null };
    expect(matchSpeedyOffice(parsed, [{ ...a, courierOfficeId: null }, twin]).kind).toBe("ambiguous");
    expect(matchSpeedyOffice(parsed, [b])).toEqual({ kind: "none" });
    const idOther = { ...b, courierOfficeId: 275 };
    expect(matchSpeedyOffice(parsed, [idOther, { ...a, courierOfficeId: null }]).kind).toBe("ambiguous");
  });
});
