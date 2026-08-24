# Feedly MCP-connector — spec

En åpen MCP-server som gir en agent lesetilgang til *brukerens eget*
Feedly-abonnement. Distribueres fra git. Hver bruker installerer og kjører den
selv, med sitt eget token. Ingen hosting, ingen mellomledd.

API-observasjonene under «Verifisert» er testet mot live-API-et 21.08.2026.
Dokumentet omskrevet 21.08.2026 etter at distribusjonsformen ble avklart.
Synket med dokumentasjonen 23.08.2026.

Dette er designdokumentet — begrunnelsene, og hva som bevisst er utelatt.
Brukervendt dokumentasjon ligger i `README.md`, `docs/configuration.md` og
`docs/tools.md`. Endrer du returformer eller confignøkler her, må de følge etter.

---

## 1. Formål

En agent skal kunne svare på «hva er nytt i feedene mine» uten å fjernstyre
nettleseren. Lesing er primærmålet. Skriving (markere som lest) er sekundært og
skal være avskrudd som standard.

**Connectoren er en oversetter, ikke en applikasjon.** Den tar imot et
verktøykall, ringer Feedly, vasker svaret og returnerer. Den akkumulerer ikke.

Denne grensen avgjør mye av det som følger, så den er verdt å skrive presist:

> Cache er ikke arkiv. Å huske et svar i minutter eller timer for å slippe å
> stille samme spørsmål på nytt, er oversetterjobb. Å lagre artikler over tid
> for å kunne svare på *nye* spørsmål, er en applikasjon.

**Ikke i scope:** daglige sammendrag, rangering over tid, «hva er viktig i dag»,
varsling, OPML-import/eksport, Boards, Notes/Highlights, Leo-regler.

Alt over streken bygges i laget over connectoren — et Claude Project med
instruksjoner, en skill, en planlagt jobb. Ikke her. Det er også det som gjør
prosjektet lite nok til å bli ferdig.

---

## 2. Distribusjonsform

Tre lag. Bygg dem i denne rekkefølgen.

### 2.1 stdio-server via pakkeregister (gulvet — må virke)

Publiseres til npm (eller PyPI). Brukeren limer inn en blokk i MCP-konfigurasjonen
og trenger ikke klone eller bygge noe:

```json
{
  "mcpServers": {
    "feedly": {
      "command": "npx",
      "args": ["-y", "feedly-mcp"],
      "env": { "FEEDLY_TOKEN": "..." }
    }
  }
}
```

I Claude Code: `claude mcp add`.

### 2.2 MCP Bundle — ettklikks-installasjon i Claude Desktop

Én fil (`.mcpb`; het `.dxt` da formatet kom — verifiser gjeldende filendelse og
CLI-navn før publisering, dette har blitt omdøpt én gang) som inneholder server,
avhengigheter og et manifest.

Manifestet deklarerer et **innstillingsskjema** som Claude Desktop rendrer for
brukeren. Felt merket som følsomme lagres i operativsystemets nøkkelring, ikke i
klartekst. Verdiene sendes inn til serveren som miljøvariabler.

Dette er hovedgrunnen til kravet i §4.1: konfigurasjon må kunne komme fra
miljøvariabler, ellers kan den ikke bundles.

### 2.3 MCP-registeret

For at folk skal finne den. Oppdagelse, ikke installasjon. Kommer sist.

### Språkvalg

**TypeScript anbefales**, av én grunn: å pakke Python-avhengigheter inn i et
bundle som skal virke på en vilkårlig maskin er merkbart mer rot enn å pakke
`node_modules`. Skal du droppe §2.2 og bare distribuere via `uvx`, er Python
like godt.

---

## 3. Autentisering

`Authorization: Bearer <token>` mot `https://api.feedly.com`.

Hver bruker bruker sitt eget token mot sin egen konto. Serveren er aldri
autorisasjonsserver, megler ingenting, og lagrer ingen andres legitimasjon.

### Verifisert

- Cookie-auth alene gir **401** — `Bearer` kreves selv fra en innlogget feedly.com-fane.
- CORS: preflight fra `feedly.com` til `api.feedly.com` returnerer **204**.

### Åpent spørsmål — hvem kan i det hele tatt skaffe et token

Dokumentasjonen motsier seg selv. Dette blokkerer ikke lenger *byggingen*, men
det avgjør hvor mange som kan bruke resultatet:

- **developer.feedly.com** (gamle Cloud API): developer-token via
  `feedly.com/v3/auth/dev`, gyldig 30 dager, oppgitt å fungere på gratiskonto.
  Pro/Team kan fornye med refresh token.
- **developers.feedly.com** (nyere Enterprise-doc): «Self service API tokens are
  only available to Enterprise clients», via `feedly.com/i/team/api`.

Test `feedly.com/v3/auth/dev` med en gratiskonto før du publiserer. Svaret
bestemmer hva README skal love.

### Krav

- Token leses **kun** fra miljøvariabelen `FEEDLY_TOKEN` eller fra en fil med
  0600-rettigheter. Aldri fra konfigfila.
- Token skal aldri returneres i verktøysvar, logger eller feilmeldinger.
- Ved 401: en tydelig «token utløpt»-feil med fornyingslenke og navn på
  miljøvariabelen. Ikke en stacktrace.

### Tokenets levetid er en UX-sak, ikke en teknisk sak

30 dager på gratiskonto er den ene tingen du ikke kan fikse for brukerne dine.
Skriv det rett ut i README, og gjør 401-meldingen så god at folk vet hva de skal
gjøre uten å åpne et issue. Ellers får du det samme issuet hver måned.

---

## 4. Konfigurasjon

### 4.1 Kilder og presedens

**Miljøvariabel → konfigfil → standardverdi.**

Miljøvariabler må dekke *alle* innstillinger, ikke bare tokenet — bundlet i §2.2
har ingen annen vei inn. Navnekonvensjon: `FEEDLY_MCP_<SEKSJON>_<NØKKEL>`,
f.eks. `FEEDLY_MCP_BUDGET_DAILY_CALLS`.

Konfigfil: `~/.config/feedly-mcp/config.toml`, overstyrbar med `--config`.

### 4.2 Skjema

```toml
[feedly]
# tokenet står ALDRI her. enten FEEDLY_TOKEN som miljøvariabel,
# eller en fil med 0600-rettigheter:
token_file = "~/.config/feedly-mcp/token"
api_base   = "https://api.feedly.com"   # kun for Enterprise-tenants med egen host

[scope]
# hvilke mapper agenten får se i det hele tatt. tom liste = alle
include_folders = ["AI"]
exclude_folders = ["Privat", "Jobb - internt"]
default_folder  = "AI"        # brukes når agenten ikke oppgir noe

[defaults]
hours         = 8
limit         = 100
unread_only   = true
summary_chars = 400
full_text     = false         # slår på summary_full

[budget]
daily_calls        = 40       # av verifiserte 50 — resten spares til nettleseren
session_calls      = 15
session_idle_reset = "15m"    # stille periode som nullstiller sesjonstelleren
warn_below         = 10       # advar i verktøysvaret, ikke bare i loggen

[cache]
metadata_ttl = "24h"          # kategorier + abonnementer
articles_ttl = "15m"
dir          = "~/.cache/feedly-mcp"   # respekterer XDG_CACHE_HOME

[writes]
enabled        = false        # mark_read i det hele tatt
bulk_mark_read = false        # mark_read på hele mapper
```

### 4.3 `scope` må håndheves, ikke bare filtrere menyen

Er `include_folders` satt, skal `list_folders` skjule resten **og**
`get_articles` avvise en `folder` utenfor lista — også når agenten sender en
rå ID den har sett et annet sted. Filtrerer du bare oppføringen, er
avgrensningen kosmetisk.

Dette er også stedet den personlige konteksten hører hjemme. At hovedmappa heter
`AI` er en brukerinnstilling, ikke noe som skal ligge i koden.

---

## 5. API-grunnlag

### ID-former (verifisert)

```
bruker      user/<uuid>
kategori    user/<uuid>/category/<label|uuid>
feed        feed/<xml-url>
global      user/<uuid>/category/global.all
```

Kategori-ID-en er enten et lesbart navn (eldre mapper) eller en UUID (nyere).
Anta aldri det ene. Hent lista fra `/v3/categories` og slå opp.

Bruker-ID hentes fra `/v3/profile`. Aldri hardkodet, aldri utledet.

`streamId` **må** URI-enkodes.

### Endepunkter

| Metode | Sti | Bruk |
|---|---|---|
| GET | `/v3/profile` | verifiser token, hent bruker-ID |
| GET | `/v3/categories` | mapper med `id` og `label` |
| GET | `/v3/subscriptions` | alle feeds, med `categories[]` |
| GET | `/v3/streams/contents` | artikler med innhold |
| GET | `/v3/streams/ids` | kun ID-er — billigere for telling |
| GET | `/v3/markers/counts` | uleste per feed og mappe |
| POST | `/v3/markers` | marker som lest |
| GET | `/v3/search/feeds` | finn nye kilder |

`POST/DELETE /v3/subscriptions` er bevisst utelatt — se §8.

### streams/contents — parametre (verifisert mot doc)

| Param | Merknad |
|---|---|
| `streamId` | påkrevd, URI-enkodet |
| `count` | 1–100, default 20 |
| `newerThan` | unix ms, **maks 31 dager tilbake** |
| `olderThan` | unix ms |
| `unreadOnly` | bool |
| `ranked` | `newest` \| `oldest` |
| `continuation` | paginering; kommer i svaret |

Webappen kaller den slik (fanget fra nettverksloggen):

```
GET /v3/streams/contents
  ?streamId=user%2F<uuid>%2Fcategory%2FAI
  &count=40&unreadOnly=true&ranked=newest&similar=true
  &continuation=<id>&ct=feedly.desktop&cv=31.0.3124
```

### markers — body

```json
{"action":"markAsRead","type":"entries","entryIds":["..."]}
{"action":"markAsRead","type":"feeds","feedIds":["..."],"asOf":1755800000000}
```

---

## 6. Verktøyflate

Hold den liten. Seks verktøy dekker alt reelt bruk.

| Verktøy | Inn | Ut |
|---|---|---|
| `list_folders` | – | `[{id,label,unread}]` |
| `list_feeds` | `folder?` | `[{id,title,folders[],unread}]` |
| `get_articles` | `folder?`, `hours?`, `unread_only?`, `limit?` | normaliserte artikler |
| `unread_counts` | – | totalt + per mappe |
| `search_feeds` | `query`, `limit?` | kandidatkilder med `feedId` |
| `mark_read` | `entry_ids[]` **eller** `folder`+`older_than` | antall markert |

Utelatte parametre faller tilbake på `[defaults]` i konfigurasjonen.

`folder` godtar både lesbar etikett og rå ID. Serveren slår opp mot den cachede
kategorilista. Agenten skal aldri måtte kjenne UUID-er.

### Normalisert artikkel

Rå Feedly-JSON er tung — `content.content` kan være hele artikkelen. Normaliser
før retur, ellers spiser ett kall hele kontekstvinduet:

```json
{
  "id": "...",
  "title": "...",
  "source": "r/LocalLLaMA",
  "url": "https://...",
  "published": 1755800000000,
  "folders": ["AI", "AI - Local Models"],
  "engagement": 214,
  "summary": "kuttet til summary_chars, HTML strippet"
}
```

Ikke returner `content`, `visual`, `origin` rått, eller `enclosure`.
`summary_full` legges bak `defaults.full_text`.

`folders[]` fylles lokalt fra den cachede `/v3/subscriptions` og koster ingenting.
Uten det er dedupliseringen ugjennomsiktig — agenten kan ikke se hvorfor en
artikkel dukket opp, eller at den dekker flere mapper samtidig.

`get_articles` returnerer i tillegg `truncated: true` når `limit` kuttet
resultatet. Ellers vet ikke agenten om den ser alt, og den kan ikke skille «lite
nytt» fra «for mye til å vise».

`search_feeds` returnerer `already_subscribed` per treff, avledet lokalt fra
abonnementslista. Gratis, og hindrer at agenten foreslår kilder du har.

### Meta på hvert svar

Hvert verktøysvar bærer et lite meta-objekt:

```json
{
  "calls_used": 12,
  "calls_left_today": 188,
  "fetched_at": 1755800000000,
  "from_cache": false
}
```

Det er brukerens egen kvote som brennes. De har krav på å se den. `fetched_at`
lar agenten si «per kl. 14:03» i stedet for å late som alt er ferskt — og
`from_cache` er det som gjør `fetched_at` tolkbart, siden et cachet svar kan være
`articles_ttl` gammelt uten at noe annet i svaret røper det.

**Begge feltene skal være pessimistiske.** Flere verktøy bygger svaret sitt av
mer enn én forespørsel, som kan være ferske eller cachet uavhengig av hverandre.
`fetched_at` skal derfor rapportere den **eldste** kilden, og `from_cache` skal
være sann når **minst én** kom fra cache. Bruker du «alle» i stedet for «minst
én», får du `from_cache: false` ved siden av et to timer gammelt tidsstempel — og
da er feltene verre enn ubrukelige, for de motsier hverandre.

Fella er ikke teoretisk: den første implementasjonen hardkodet
`fetched_at: Date.now(), from_cache: false` i `list_folders` og gjorde nøyaktig
det denne seksjonen finnes for å hindre.

### Feiltaksonomi

| Situasjon | Svar |
|---|---|
| 401 fra Feedly | «token utløpt» + fornyingslenke + navn på miljøvariabel |
| 429 fra Feedly | tydelig feil med `X-Ratelimit-Reset`. **Ingen retry-loop.** |
| Budsjett brukt opp | egen feil som skiller seg fra 429 — det er serverens grense, ikke Feedlys |
| Mappe utenfor `scope` | avvis, og si at den er utenfor konfigurert scope |

---

## 7. Rate limits — det viktigste designkravet

### Verifisert 23.08.2026 — dokumentasjonen tar feil

Ett kall til `/v3/profile` med et developer-token på en **Pro Plus**-konto
(`FeedlyProPlusYearly144`, aktivt abonnement) ga:

```
x-ratelimit-limit: 50
x-ratelimit-count: 1
x-ratelimit-reset: 41655        # ~11t34m → døgnvindu, lander nær midnatt UTC
```

**50 kall i døgnet.** Ikke 250, ikke 500. Dokumentasjonen som oppgir «250 på
gratis, 500 på Pro» stemmer ikke med det API-et faktisk sender.

Ubekreftet hypotese: taket på 50 gjelder trolig **developer-tokens spesifikt**,
ikke kontonivået. Det ville forklare motsigelsen. Verifiser mot et OAuth-token
hvis du noen gang får et — men ikke bruk kvote på å grave i dette uten grunn.

Praktisk konsekvens: **planlegg for 50.** Er det egentlig mer, koster antakelsen
deg ingenting. Er det ikke, redder den prosjektet.

### Hva 50 betyr

Én samtale der agenten kaller `list_folders`, så `unread_counts`, så
`get_articles` på tre mapper, bruker 6+ kall. Det er åtte samtaler i døgnet.

Dette er ikke en grense du designer rundt i etterkant. Den er premisset.
Caching er ikke en optimalisering her — den er det som gjør verktøyet brukbart.

Svarene bærer `X-Ratelimit-Count`, `X-Ratelimit-Limit` og `X-Ratelimit-Reset`.
Over kvoten: HTTP 429.

Kvoten henger på kontoen. Hver bruker kommer med sin egen — de konkurrerer ikke
om en felles pott. Men det betyr også at en overivrig agent tømmer *brukerens*
kvote, og da er Feedly utilgjengelig i nettleseren deres også resten av døgnet.
Budsjettet i §4.2 er brukerens vern mot sin egen agent.

**`daily_calls` måles kontoomfattende, ikke per server.** Den sjekkes mot
`X-Ratelimit-Count`, som teller alle klienter på kontoen — også nettleseren. Har
brukeren brukt 38 kall selv i dag, nekter serveren på 40 uten å ha gjort ett
eneste. Det er tilsiktet: poenget er å etterlate en fungerende Feedly.

Men feilmeldingen må da si begge tall. «This server's daily budget is spent»
ville vært direkte usant i det tilfellet, og verre: den ville sendt brukeren for
å heve et tak som ikke var problemet.

Krav:

- **Cache `/v3/categories` og `/v3/subscriptions` på disk**, ikke bare i minnet.
  Prosessen dør mellom samtaler; uten disk-cache hentes de på nytt hver gang.
  TTL fra `cache.metadata_ttl`, som med 50-taket bør stå på **24t**. Hentes de
  fire ganger i døgnet, er 8 av 50 kall brukt på lister som nesten aldri endrer
  seg. Motytelsen er at et nytt abonnement kan ta et døgn før det synes —
  akseptabelt, gitt at `doctor --refresh` tømmer cachen når du trenger det.
- **Ett kall per mappe, aldri ett per feed.** `streamId` på mappenivå henter alt
  under den.
- **Ligger alt i én toppmappe, hent bare den.** Mappetilhørighet regnes ut
  lokalt fra den cachede `/v3/subscriptions`, som allerede oppgir `categories[]`
  per feed. Ett kall dekker da hele abonnementet.
- **Memoiser artikkelsvar** på (streamId, parametre) i `cache.articles_ttl`.
  Spør agenten to ganger om samme mappe i samme samtale, skal det koste ett kall.
- **Les `X-Ratelimit-Count` fra hvert svar** og eksponer det. Under
  `budget.warn_below`: advarsel i verktøysvaret, ikke bare i loggen.
- **Hardt tak** på `budget.session_calls` og `budget.daily_calls`, uansett hva
  agenten ber om. To fallgruver, begge påvist i drift:

  **En stdio-prosess er ikke én samtale.** Klientene starter serveren én gang og
  holder den i live så lenge appen kjører — målt til over 15 timer — og alle
  samtaler deler den. En teller i minnet nullstilles da bare når appen avsluttes,
  så «10 kall per sesjon» betyr i praksis «10 kall til du restarter Claude». En
  planlagt kjøring arver et oppbrukt budsjett den aldri kan tømme. Bruk et
  opphold i aktivitet som sesjonsgrense i stedet.

  **Sjekk uten reservasjon holder ikke.** Flere verktøy fyrer samtidige kall —
  mappeindeksen alene gjør tre. Sjekker du taket uten å telle opp i samme
  operasjon, passerer alle tre mens telleren fortsatt står under grensen. Målt:
  tak på 10 nådde 12, og feilmeldingen sa da «12/10», som ser ut som en teller
  som aldri nullstilles. Reserver plassen, og gi den tilbake hvis kallet aldri
  nådde fram.

---

## 8. Skriveoperasjoner

`mark_read` er **irreversibelt**. Feedly har ingen angreknapp, og gjenoppretting
krever e-post til support. Derfor:

- Av som standard. Slås på med `writes.enabled`.
- `mark_read` uten `entry_ids` — altså hele mapper — krever i tillegg
  `writes.bulk_mark_read`. To brytere, fordi de to operasjonene har helt ulik
  skadevidde.
- **`unsubscribe` implementeres ikke.** Det er sletting av brukerens data, uten
  angremulighet, utført av en agent. Verdien står ikke i forhold. La folk si opp
  abonnementer i Feedly.
- **Et felt som rapporterer hva en skriveoperasjon gjorde, må måles — ikke
  antas.** Feedly returnerer ingen telling for markering på mappenivå. Første
  implementasjon returnerte mappas ulestetall *før* kallet under navnet
  `marked_approximately`, med en fotnote som forklarte det. I bruk leste det som
  suksess: en feie som traff ingenting rapporterte et femsifret tall. Fotnoter
  taper mot feltnavn. Mål differansen i stedet, og returner `null` når den ikke
  lar seg måle.
- Skriveoperasjoner går alltid live til Feedly og skal invalidere berørte
  cache-oppføringer. **Berørte er mer enn tellerne:** et cachet `unreadOnly`-svar
  inneholder fortsatt artiklene som nettopp ble markert lest, og ville servert
  dem tilbake resten av `articles_ttl`. Både `markers/counts` og alle
  `stream:`-oppføringer må ryddes.

---

## 9. Arkitektur

Stdio-server. Én prosess, startet av MCP-klienten ved behov, dør etterpå.
Tokenet blir liggende hos brukeren.

Fire deler, holdt fra hverandre:

```
verktøylag    MCP-verktøydefinisjoner, validering, scope-håndheving
klientlag     Feedly-HTTP, budsjettelling, feiloversetting
cachelag      disk, TTL-basert, kun metadata + memoiserte svar
konfiglag     env → fil → default
```

Cachen ligger under `~/.cache/feedly-mcp/` (eller `XDG_CACHE_HOME`). Én bruker
per installasjon — ingen brukerdimensjon i lagringen.

### `doctor`-kommando

`npx feedly-mcp doctor` skal:

1. finne tokenet og si hvor det ble funnet (aldri skrive det ut)
2. kalle `/v3/profile` og vise kontoen
3. liste mapper med ID-er — som også er hjelpen brukeren trenger for å fylle ut `scope`
4. vise kvoteforbruk og hvor lenge tokenet har igjen, hvis det lar seg lese
5. si tydelig fra hvis konfigurasjonen peker på mapper som ikke finnes

Dette er §10 steg 1 gjort om til et verktøy, og det er forskjellen mellom
«virker ikke» og «å, tokenet er utløpt».

---

## 10. Byggerekkefølge

1. `curl` mot `/v3/profile` med et developer-token fra en **gratiskonto**.
   Avklarer §3 samtidig som det beviser kjeden.
2. Konfiglaget med presedens env → fil → default. Alt annet henger på dette.
3. `doctor`.
4. `list_folders` + `unread_counts` — minst mulig som beviser hele kjeden.
5. Cache, budsjett og feiltaksonomi. **Før** flere verktøy.
6. `get_articles` med normalisering og paginering.
7. `search_feeds` og `list_feeds`.
8. `mark_read`, bak begge flagg.
9. Publiser til npm. README med tokenets levetid tydelig oppe.
10. MCP Bundle.
11. Registeret.

---

## 11. Fallgruver

- `newerThan` lenger tilbake enn 31 dager gir tomt svar, ikke feil. Derfor:
  `hours` klemmes til maks 744 i verktøylaget, og klemmingen sies fra om i
  svaret. Slipper du verdien gjennom urørt, ser «ingenting siste to måneder» ut
  som et gyldig resultat.
- `continuation` mangler i svaret når du er ved enden — ikke tolk det som feil.
- Reddit-feeds kommer som `feed/https://api.reddit.com/subreddit/<navn>`;
  `origin.title` er da `r/<navn>`.
- Samme artikkel kan dukke opp i flere mapper. Dedupliser på `id`.
- Ligger alle feeds også i en toppmappe, må du ikke summere uleste på tvers av
  mapper — da dobbelttelles alt.
- `engagement` er Feedlys popularitetsmål, nyttig til rangering, men mangler
  eller er 0 på ferske saker. Ikke sorter kun på den.
- Cache som overlever en tokenbytte kan servere data fra feil konto. Nøkle
  cachen på bruker-ID fra `/v3/profile`.
- Standardverdier som `hours = 8` er *dine* vaner. De skal være overstyrbare,
  og README bør si hva de er.

---

## Vedlegg: kontostruktur å teste mot

**Syntetisk eksempel.** Ingen ekte ID-er i dette dokumentet — hent dine egne fra
`doctor`. Poenget er formen, ikke tallene.

Den strukturen som er verdt å teste mot, er en toppmappe som inneholder alt,
pluss temamapper der de samme feedene går igjen:

```
bruker-ID   user/<uuid>
toppmappe   user/<uuid>/category/Tema          (70 feeds)

temamapper (nyere mapper har UUID som ID, ikke lesbart navn):
  user/<uuid>/category/<uuid>   Undertema A    12 feeds
  user/<uuid>/category/<uuid>   Undertema B    15
  user/<uuid>/category/<uuid>   Undertema C    13
  …
```

Alle 70 ligger også i toppmappa. Det gjør denne formen til den nyttigste
testcasen i spec-en, fordi den treffer to ting samtidig:

- **enkeltkall-optimaliseringen i §7** — ett kall mot toppmappa dekker hele
  abonnementet, og mappetilhørighet regnes ut lokalt.
- **dobbelttellingsfella i §11** — summerer du uleste på tvers av mapper, teller
  du hver artikkel minst to ganger.

Har kontoen din denne formen, sett toppmappa som `default_folder`. Det er både
det mest nyttige og det billigste standardvalget:

```toml
[scope]
include_folders = ["Tema"]
default_folder  = "Tema"
```
