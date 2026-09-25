/**
 * Input-hygiene regression test: browsers autocorrect and autocapitalize
 * free-text entry, silently mangling pasted BIP-39 phrases ("bean" became
 * "been"/"Bean" and the server rejected the phrase). Every input that holds
 * a seed phrase, passphrase, or wallet address must disable the rewriters.
 *
 * Asserted against react-dom/server output, so no DOM environment is needed:
 * react renders these props as lowercase HTML attributes on the elements.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddressPanel } from "./AddressPanel";
import { CustomWalletPanel } from "./CustomWalletPanel";

/** Attribute spellings as react-dom/server emits them. */
const HYGIENE_ATTRS = [
  'spellcheck="false"',
  'autocapitalize="none"',
  'autocorrect="off"',
  'autocomplete="off"',
] as const;

function inputTags(html: string): string[] {
  return html.match(/<(?:textarea|input)\b[^>]*>/g) ?? [];
}

function expectHygiene(tag: string, attrs: readonly string[]): void {
  // react-dom/server emits most attributes in camelCase ("autoCapitalize");
  // HTML attribute names are case-insensitive, so normalize before matching.
  const lowered = tag.toLowerCase();
  for (const attr of attrs) {
    expect(lowered).toContain(attr);
  }
}

describe("input hygiene on phrase/address inputs", () => {
  it("CustomWalletPanel disables autocorrect/capitalize on mnemonic, passphrase, and cross-check inputs", () => {
    const html = renderToStaticMarkup(
      <CustomWalletPanel
        chain="bitcoin"
        onChain={() => {}}
        mode="classic"
        disabled={false}
        estimatedRate={null}
        onDerived={() => {}}
      />,
    );
    const tags = inputTags(html);

    const textarea = tags.filter((tag) => tag.startsWith("<textarea"));
    expect(textarea).toHaveLength(1);
    expectHygiene(textarea[0] ?? "", HYGIENE_ATTRS);

    const passphrase = tags.filter((tag) => tag.includes('type="password"'));
    expect(passphrase).toHaveLength(1);
    expectHygiene(passphrase[0] ?? "", HYGIENE_ATTRS);

    const crossCheck = tags.filter((tag) =>
      tag.includes("the address your wallet app shows"),
    );
    expect(crossCheck).toHaveLength(1);
    expectHygiene(crossCheck[0] ?? "", HYGIENE_ATTRS);
  });

  it("AddressPanel target address input disables autocorrect/capitalize", () => {
    const html = renderToStaticMarkup(
      <AddressPanel
        address=""
        onAddress={() => {}}
        verdict={null}
        checking={false}
        corpus={null}
        corpusError={null}
        onDemoWallet={() => {}}
        disabled={false}
      />,
    );
    const inputs = inputTags(html).filter((tag) => tag.startsWith("<input"));
    expect(inputs).toHaveLength(1);
    expectHygiene(inputs[0] ?? "", HYGIENE_ATTRS);
  });
});
