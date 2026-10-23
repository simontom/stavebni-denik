import type { ReactNode } from "react";
import { Banner } from "./Banner";

/**
 * What a dialog says when the server has not answered for a long time (`useStalled`): it does not say the action failed, and it does not say
 * it went through, because nobody knows. [children] says what to check afterwards, in the words of the action; the default is the
 * general one. The dialog offers "Zavřít" next to it.
 */
export function StalledNotice({ children }: { children?: ReactNode }) {
  return (
    <Banner tone="warning">
      <p className="font-semibold">Server neodpovídá.</p>
      <p>{children ?? "Nevíme, jestli se akce provedla: zkontrolujte to po zavření dialogu a případně ji zopakujte."}</p>
    </Banner>
  );
}
