# Vault & titkosítás

> Az API-kulcsok nem plaintext fájlokban hevernek. Titkosított széf, OS-kulcstárral.

---

## 🎯 Mit tud / miért érdekes

Az MCP-szerverek API-kulcsait, tokenjeit és jelszavait egy **titkosított vault** kezeli (AES-256-GCM). A Claude Code alapból **plaintext**-ben tárolja ezeket a `.mcp.json`-ben — ami biztonsági kockázat: bármely process olvashatja, prompt-injection kiszedheti, és véletlenül git-be is kerülhet.

A vault ezt úgy oldja meg, hogy a `.mcp.json`-ben csak `vault:SECRET_ID` referenciák állnak, a tényleges értékek titkosítva vannak, és csak induláskor, memóriában oldódnak fel. Az ügynökök a titok értékét sosem írják ki (logba, üzenetbe) — referenciaként használják.

**Kuriózum:** a beolvasáskor a rendszer a titkot a működő folyamatba injektálja anélkül, hogy az érték valaha is megjelenne a transzkriptben vagy egy fájlban — így egy kulcsot fel lehet használni úgy, hogy az asszisztens "nem is látja".

---

## 🛠 Hogyan működik

### Master key tárolás

- **macOS**: a master key a Keychain-ben (`com.<slug>.vault` service) — az OS titkosított kulcstára, a disk encryption része, a bejelentkezéshez kötött, transzparens. Korábbi fájl-alapú kulcs (`store/.vault-key`) első induláskor automatikusan a Keychain-be migrálódik.
- **Linux**: a Keychain nem elérhető → fájl-alapú master key (`store/.vault-key`, `chmod 600`), közvetlenül a titkosított `store/vault.json` mellett. A titkosítás itt is AES-256-GCM. **Ami ez ellen véd**: offline lemez-lopás — a `store/.vault-key` és a `store/vault.json` is ugyanabban a jogosultsági tartományban van (`store/`, ugyanaz a uid), így a disk encryption (LUKS ajánlott éles környezetben) az adathordozó elvitele/kiszerelése ellen ad valódi védelmet. **Ami ez ellen NEM véd**: egy élő, ugyanazon a gépen, ugyanazon uid alatt futó olvasó — az a `store/` mappán keresztül a kulcsot és a titkosított titkokat is ugyanúgy eléri, mint a szerver maga. Ezt a rést zárja (S4.4, B6-SEC-4) a 6 biztonsági profil deny-listája, amely explicit tiltja a `Read(**/store/.vault-key)` és `Read(**/store/vault.json)` mintát: a szigorú kutató/terjesztő profilokon (analyst-draft, content-draft, distribution-velocity, visual-production) ez valódi blokk, mert ott a Read tool az egyetlen olvasási út; a két fejlesztői profilon (developer-sandbox, developer-trusted) csak defense-in-depth, mert a széles shell-hozzáférés (`cat`, `python3`) megkerüli a Read()-denyt (lásd a profilok `_securityNote` mezőit). A teljes, ügynökök közötti kulcs-izoláció valódi megoldása a Hard OS-isolation (Solvian ütemterv §6.1), ami skálázás előtt van betervezve; addig a Linux fájl-kulcs egy tudatosan elfogadott, dokumentált maradványkockázat (residual risk) — a go-live risk listán / a B6-SEC-4 backlog-tételen kell nyomon követni, nem úgy kezelni, mintha ugyanazt a védelmet adná, mint a macOS Keychain egy más felhasználó vagy folyamat ellen.

### Scan & Import

A dashboard Vault-oldalán a **Scan & Import** megkeresi a `.mcp.json` fájlokban lévő plaintext titkokat és felajánlja az importálást. Utána a `.mcp.json`-ben `vault:SECRET_ID` referencia áll a plaintext helyett, és az MCP-parancs becsomagolódik a `vault-env-wrapper.sh`-val, ami induláskor feloldja a referenciákat.

A scanner a `.mcp.json` `env` szekciójának érzékeny kulcsait fogja (`_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `API_*`, `AUTH_*`, `OAUTH_*` stb.). Az `args`-ban átadott titkokat (pl. `--api-key`) nem érzékeli — azokat manuálisan env-re kell állítani.

### Struktúra

```
store/vault.json               # titkosított titkok (AES-256-GCM)
store/vault-bindings.json      # titok ↔ MCP-szerver hozzárendelés
scripts/vault-env-wrapper.sh   # runtime feloldó wrapper
scripts/vault-resolve.mjs      # secret ID → plaintext feloldás
```

### Ügynök-használat

Az ügynökök programatikusan kiolvashatják a titkot (pl. egy press-CLI auth beállításához) a dist vault-modulon át — érték kiírása nélkül. A titkok címke (label) szerint azonosítva. A dashboard `/api/autonomy`-hoz hasonlóan Bearer-token védett API.
