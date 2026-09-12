import { z } from "zod";

export const projectMemberRoleSchema = z.enum(["BOSS", "WORKER", "INSPECTOR", "INVESTOR"]);

export const meterStateItemSchema = z.object({
  name: z.string().trim().min(1, "Název média je povinný"),
  number: z.string().trim().default(""),
  value: z.string().trim().min(1, "Stav je povinný"),
});

export type MeterStateItem = z.infer<typeof meterStateItemSchema>;

export const createHandoverSchema = z.object({
  type: z.string().trim().min(1, "Typ předání je povinný"),
  date: z.coerce.date(),
  participants: z.string().trim().min(1, "Účastníci předání jsou povinní"),
  meterStates: z.preprocess((val) => {
    if (!val || val === "" || val === "null") return null;
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return null;
      }
    }
    return val;
  }, z.array(meterStateItemSchema).nullable().default(null)),
  notes: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : null)),
});

export type CreateHandoverInput = z.infer<typeof createHandoverSchema>;

export const authorizedPersonSchema = z.object({
  name: z.string().trim().min(1, "Jméno je povinné"),
  company: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
  authorization: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
});

export type AuthorizedPersonInput = z.infer<typeof authorizedPersonSchema>;
