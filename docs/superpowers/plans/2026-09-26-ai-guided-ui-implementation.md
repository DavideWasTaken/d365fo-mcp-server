# AI-guided UI verification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consentire all'AI del client di esplorare D365 nel browser, adattare il percorso di due casi dal requisito e produrre un report fondato su evidenze, con consumo limitato.

**Architecture:** Sessione Playwright persistente controllata con azioni brevi dentro `verify_ui_customization`; AI nel client, osservazione/azioni/journal/check nel server. Riutilizzare profili, Edge, login, guard delle navigazioni e report esistenti; conservare il runner deterministico. Supportare l'endpoint confermato `http://localhost:8080/mcp` con sessioni applicative fra richieste HTTP e anche stdio, senza modello/API key LLM aggiuntivi.

**Tech Stack:** Node 24, TypeScript, Zod, Playwright già installato, MCP SDK esistente, Vitest e fixture HTTP locali.

---

Spec: [disegno dettagliato](../specs/2026-09-26-ai-guided-ui-design.md). Base: `a768940a`. Implementazione successivamente autorizzata con "procedi e pubblica". L'utente preferisce lavorare sul proprio `main`, senza nuove branch/worktree; questa preferenza prevale sul default della skill.

## Chunk 1: Fondazioni e contratto

### Task 1: Verificare snapshot e riferimenti con la dipendenza reale

**Files:** Create `tests/tools/ui-guided-observation.integration.test.ts`; Create `src/tools/sdlc/uiVerification/guided/targets.ts`; eventuale modifica mirata `package.json`/`package-lock.json` solo per fissare la versione effettivamente collaudata.

- [ ] Scrivere fixture con bottone, input etichettato, duplicato nascosto, dialog, iframe autorizzato e riga virtualizzata che riusa lo stesso nodo cambiandone il testo.
- [ ] Testare `page.ariaSnapshotJSON({mode:'ai'})` e risoluzione del riferimento verso l'elemento corretto; registrare come viene risolto `aria-ref` e vietare import di moduli privati Playwright.
- [ ] Test RED per riferimento di un altro snapshot/caso, elemento sostituito e riga riciclata: zero click sul target sbagliato, `NEEDS_OBSERVATION`.
- [ ] Implementare adapter `captureTargets(page)` / `resolveObservedTarget(snapshotId, ref)` con controllo documento, ambito, identità e impronta; non risolvere il ref su una copia nuova dello snapshot.
- [ ] Run `npm run test:integration -- tests/tools/ui-guided-observation.integration.test.ts --maxWorkers=1`. Atteso: test verdi con browser reale; nessuna nuova richiesta a D365.
- [ ] Se l'engine dei riferimenti è incompatibile, usare un registro di ElementHandle osservati tramite API pubbliche, con stesse invalidazioni. Decidere in questo task, prima di costruire le azioni; niente patch interne al pacchetto.
- [ ] Commit mirato del solo adapter e test, dopo revisione.

### Task 2: Definire missione, azioni, limiti e risultati

**Files:** Create `src/tools/sdlc/uiVerification/guided/contract.ts`; Modify `src/tools/sdlc/uiVerification/contract.ts`, `src/server/toolSchemas/verifyUiCustomization.ts`; Create `tests/tools/ui-guided-contract.test.ts`; Modify `tests/tools/verify-ui-customization.test.ts`, `tests/utils/toolSchemaBudget.test.ts` solo per nuove aspettative senza aumentare i cap.

- [ ] Scrivere test RED per missione 1–5 casi, criterio obbligatorio, build non pronta, expected immutabile, azione sconosciuta, batch >3, limiti sopra cap e assenza di codice/eval nel contratto.
- [ ] Definire `GuidedMission` con requirement/buildReference/company/startUrl/cases; casi con ID, obiettivo, dati, preconditions e criteria. Criteri misurabili: ID, targetDescription, check, expected e match; criteri AI: ID, targetDescription, expectedDescription, kind=`ai_review`. Nessun selettore obbligatorio.
- [ ] Definire unione Zod per `start`, `observe`, `case`, `act`, `check`, `finish`, con sessionId e caseId dove servono. `check` riferisce criterionId; non ridefinisce expected/check/kind.
- [ ] `case` distingue prepare/begin/end: prepare restituisce il nuovo contesto da osservare; begin con snapshotId/companyRef della stessa pagina passa a PRECONDITIONS; act richiede tutti i check iniziali PASS. Aggiungere test negativi per precondizioni completate dopo una scrittura e ref società del caso precedente.
- [ ] Target dei check: ref osservato ordinario oppure, solo per visible:false, scopeRef osservato + query ruolo/nome esatto collegata alla targetDescription. La query di assenza è read-only, non è un selettore utilizzabile da act.
- [ ] Risultati operativi distinguono fase/errore da verdict: `NEEDS_OBSERVATION`, `BUSY`, `WRITE_UNCERTAIN`, `AUTH_REQUIRED`, `SESSION_EXPIRED` non sono FAIL funzionali.
- [ ] `contract(topic='guided')` restituisce schema/esempio/regole guidate; il default conserva il contratto precedente. Catalogo compatto sotto budget attuale; nessun tool MCP extra.
- [ ] Run `npm run test:run -- tests/tools/ui-guided-contract.test.ts tests/tools/verify-ui-customization.test.ts tests/utils/toolSchemaBudget.test.ts`. Atteso: tutti verdi e JSON integrale <24k.
- [ ] Commit del contratto dopo revisione.

### Task 3: Gestore di sessione e integrazione ciclo di vita

**Files:** Create `src/tools/sdlc/uiVerification/guided/sessionManager.ts`, `journal.ts`, `src/server/uiRequestContext.ts`; Modify `src/types/context.ts`, `src/index.ts`, `src/tools/toolHandler.ts`, `src/server/transport.ts`, `src/utils/toolMetrics.ts`; Create `tests/tools/ui-guided-session.test.ts`, `tests/server/ui-guided-http.integration.test.ts`; Modify `tests/dispatch.integration.test.ts`.

- [ ] Test RED: due sessioni HTTP non condividono Page/registry; token inesistente rifiutato; richiesta concorrente nella stessa sessione BUSY; TTL, shutdown, finish ripetuto; stessa porta/processo e richieste con ID JSON-RPC uguale arrivano alla sessione corretta. Il percorso HTTP locale NON deve essere rifiutato.
- [ ] Creare un manager per processo server e iniettarlo nel contesto passato al tool. Collegare lo stesso manager al contesto stub e a quello aggiornato senza perderlo durante DB readiness; HTTP riceve quel manager dopo initializeServices. Evitare manager inutili creati dalla seconda inizializzazione full. Cap due browser/sessioni; terzo start rifiutato senza esporre sessioni altrui.
- [ ] Passare esplicitamente dal bootstrap il tipo di trasporto effettivo: non dedurlo solo da `MCP_FORCE_HTTP` perché esiste HTTP interattivo senza quella variabile.
- [ ] Inserire nel trasporto un contesto AsyncLocalStorage dedicato alla richiesta UI con socket loopback/Host/Origin verificati e AbortSignal. `sessionId` generata da `randomBytes(32)`, distinta dal runId usato nei file; nessun lookup per workspace o request.id, nessuna API list delle capability. Mantenere apiKeyAuth e rifiutare guided da socket non locale/hosted prima di aprire browser.
- [ ] Collegare timeout o `res.close` prima di writableEnded all'AbortController della singola richiesta UI. La normale fine risposta HTTP non chiude browser/contesto. Non usare req.close indiscriminatamente: può indicare richiesta letta normalmente. `finish` interrompe la sola sessione autorizzata anche con act in corso. Start abortita prima della consegna chiude bootstrap e non esegue azioni applicative.
- [ ] Testare/documentare `notifications/cancelled` non attribuibile: ACK senza promessa di cancellazione, nessuna interruzione per ID ambiguo. La cancellazione supportata richiede abort della POST o finish autorizzato; client che invia solo notifica può lasciare l'azione fino al limite45s. Provare il client reale prima di dichiarare supportato il suo pulsante Stop.
- [ ] Escludere risposte UI strutturate dalla concatenazione progressText al primo blocco JSON; mantenere eventuale progress separato o ometterlo. Redigere capability in preview errori, recordCallSequence e reportSlowCall: passare ai log solo metadati non segreti/hash, mentre il dispatch riceve gli argomenti originali.
- [ ] Collegare `dispose()` a `onShutdown`; mantenere eventuali hook SDK onclose esistenti. Timer unref e cleanup best effort entro il limite del coordinatore.
- [ ] Journal append-only `events.jsonl` locale: identificativi, sequenze, tentativo/completamento, criteri e motivi; nessuna credenziale. Scrivere il tentativo prima del dispatch dell'interazione. Flush prima di rispondere; errore di persistenza prima del dispatch impedisce la scrittura.
- [ ] Caricare al successivo avvio gli indici minimi dei run incompleti; indicare NOT_VERIFIED/interrupted, mai riprendere azioni. Nessuna ripresa di sessioni browser dopo crash.
- [ ] Run `npm run test:run -- tests/tools/ui-guided-session.test.ts` e `npm run test:integration -- tests/dispatch.integration.test.ts tests/server/ui-guided-http.integration.test.ts --maxWorkers=1`. Atteso: sessione sopravvive a più POST, JSON parse+immagini preservati, aborto solo dell'operazione giusta, nessuna capability nei log, isolamento e no attesa symbol DB. Usare porta effimera nei test; 8080 solo configurazione dev reale.
- [ ] Commit session manager/journal/wiring dopo revisione.

## Chunk 2: Browser guidato, autenticazione e verifica

### Task 4: Bootstrap login e società senza CSS scritto dall'utente

**Files:** Create `src/tools/sdlc/uiVerification/guided/browserSession.ts`; Modify `src/tools/sdlc/uiVerification/authenticate.ts` solo per estrarre helper condivisi; Create `src/tools/sdlc/uiVerification/authState.ts` se necessario; Test `tests/tools/ui-guided-browser.integration.test.ts`; conservare `tests/tools/ui-authentication.integration.test.ts`.

- [ ] Test RED: URL vuoto domanda all'utente; sessione valida riusata; login mancante restituisce AUTH_REQUIRED rapidamente; nessuno screenshot/DOM IdP; ritorno ambiente abilita scoperta società; società errata vieta interazioni.
- [ ] `start` apre browser dedicato visibile con canale del profilo, non il profilo personale. Riutilizza `resolveUiProfile`; finché è in login applica origini autenticazione esistenti e mantiene solo interazione umana.
- [ ] `observe` durante login risponde con fase e indicazione di completarlo, senza materiale sensibile. Sul dominio D365 offre snapshot read-only per scegliere il controllo società.
- [ ] `case(prepare)` adotta il bootstrap per il primo caso o crea un contesto nuovo per i successivi, naviga all'URL iniziale e restituisce DISCOVERING con snapshotId. Non accetta ref della pagina precedente. Solo il successivo `case(begin)` valida companyRef del nuovo snapshot e valore esatto, blocca criterio società per quel contesto, salva stato in modo atomico e passa a PRECONDITIONS con guard della sola origine ambiente. Nessuna azione applicativa prima di tutti i check iniziali PASS; società ricontrollata prima di ogni interazione.
- [ ] Testare prepare/begin duplicati: nessun contesto aggiuntivo, navigazione ripetuta, reset budget o cambio implicito di caso. Prima di begin/attivazione sono ammessi solo observe/check; dati/precondizioni devono essere osservabili dalla pagina iniziale. Percorsi UI da verificare fanno parte dei passi successivi.
- [ ] Login scaduto durante caso: terminare il caso NOT_VERIFIED e indicare nuovo bootstrap esplicito, senza riprodurre il percorso già eseguito.
- [ ] Run `npm run test:integration -- tests/tools/ui-authentication.integration.test.ts tests/tools/ui-guided-browser.integration.test.ts --maxWorkers=1`. Atteso: compatibilità login precedente e niente richieste a origini vietate, incluse popup/OOPIF.
- [ ] Commit lifecycle/login dopo revisione.

### Task 5: Osservazioni compatte e immagini facoltative

**Files:** Create `src/tools/sdlc/uiVerification/guided/observation.ts`, `evidence.ts`; Modify `tests/tools/ui-guided-observation.integration.test.ts`; Create `tests/tools/ui-guided-payload.test.ts`.

- [ ] Test RED con form grande, dialog, infolog, griglia virtualizzata e password: output limitato, omissioni esplicite, messaggi non persi, password oscurata, nessuna falsa prova di assenza basata su truncation.
- [ ] Serializzare snapshot strutturato, compattarlo per ambito osservato e assegnare snapshotId/evidenceId. Cap 120 controlli e ~8k caratteri; restituire elenco di ambiti espandibili quando necessario. Scartare ref non effettivamente pubblicati.
- [ ] Filtri su nome/ruolo e scopeRef già osservato; eventuale dettaglio produce nuova osservazione fresca, non copia vecchia. Esporre valori solo dei controlli necessari e applicativi, senza ispezione di storage/rete.
- [ ] Screenshot su richiesta: viewport o elemento osservato, dimensioni/bytes limitati, password mask; image content MCP e file locale. Il JSON riporta capturedAt/document/snapshotId; mai path/base64 dell'immagine nel JSON testuale.
- [ ] Testare il dispatch reale con contenuto text+image e i cap, inclusi client senza immagini: risposta testuale utile e `IMAGE_REQUIRED` solo per un criterio che davvero richiede visione.
- [ ] Run `npm run test:run -- tests/tools/ui-guided-payload.test.ts` e fixture osservazioni. Atteso: schema JSON valido sotto cap, evidenze attribuite al caso/sessione corretti.
- [ ] Commit observation/evidence dopo revisione.

### Task 6: Azioni e recupero controllato

**Files:** Create `src/tools/sdlc/uiVerification/guided/actions.ts`, `receipts.ts`; Create `tests/tools/ui-guided-actions.integration.test.ts`, `tests/tools/ui-guided-receipts.test.ts`.

- [ ] Test RED per lookup che appare tardi, riga riciclata, dialog sovrapposto e bottone sostituito: restituire NEEDS_OBSERVATION e consentire nuova osservazione; non concludere FAIL tecnico.
- [ ] Implementare azioni validate e target solo da snapshot. Richiedere CASE_ACTIVE e precondizioni PASS. Preflight identità/società/visibilità/azionabilità prima di ciascuna azione: trial click dove supportato senza modifiers, controlli enabled/editable/hit target read-only negli altri casi. Overlay/preflight non pronto restituisce NEEDS_OBSERVATION prima del dispatch, con osservazione del dialog; nessun `force:true`, script arbitrario, selettore inventato o scelta automatica del primo duplicato.
- [ ] Batch massimo tre: per campi già osservati, revalidare ciascun target. Restituire subito dopo un'azione di controllo flusso; nessun riferimento anticipato a lookup/dialog non ancora visti. Annotare quali step sono stati tentati/completati.
- [ ] Test RED duplicati: stesso operationId/input dopo timeout di risposta non clicca due volte; ID riusato con input diverso è errore; richieste parallele diverse BUSY. Completare ricevute in memoria+journal, senza abilitare la cache generale del tool.
- [ ] Contrassegnare una ricevuta ripetuta come storica; non revalidare i vecchi ref né restituire il vecchio snapshot come corrente. Testare duplicate act dopo una nuova osservazione e dopo navigazione: nessuna nuova azione e observe obbligatoria per decidere.
- [ ] Conservativamente marcare incertezza se un'interazione potrebbe essere stata inviata. Consentire solo osservazioni/check in WRITE_UNCERTAIN e chiusura; nessuna ulteriore interazione nello stesso caso. Non dedurre assenza di scrittura da timeout Playwright.
- [ ] Budget applicati prima del dispatch: interazioni/call/immagini/recuperi, più timeout per chiamata. Chiamate brevi: 30s normalmente, cap45s; le attese più lunghe diventano osservazioni successive, evitando dipendenza da client con timeout >60s.
- [ ] Run `npm run test:run -- tests/tools/ui-guided-receipts.test.ts` e `npm run test:integration -- tests/tools/ui-guided-actions.integration.test.ts --maxWorkers=1`. Atteso: zero scritture duplicate, recuperi riusciti quando nessuna azione è stata inviata.
- [ ] Commit executor/ricevute dopo revisione.

### Task 7: Criteri immutabili e report trasparente

**Files:** Create `src/tools/sdlc/uiVerification/guided/checks.ts`, `report.ts`; Modify `src/tools/sdlc/uiVerification/report.ts` solo con campi retrocompatibili; Create `tests/tools/ui-guided-checks.test.ts`, `tests/tools/ui-guided-report.test.ts`; Extend `tests/tools/ui-guided-actions.integration.test.ts`.

- [ ] Test RED: expected non modificabile; criterio omesso non PASS; precondizione fallita NOT_VERIFIED; criterio funzionale misurato contrario FAIL; nessun finish può sovrascrivere FAIL o WRITE_UNCERTAIN.
- [ ] Bind target osservato a criterionId e verificare il check bloccato nella missione. Record: expected iniziale, targetDescription, target effettivo, observed, evidenceId, source=`measured`/`ai_reviewed` e tempi. Una binding sbagliata dell'AI resta visibile nel report, non viene presentata come certezza.
- [ ] AI review solo per criteri di quel tipo fin dall'inizio, con motivazione e ID di evidenze della stessa sessione/caso. Rifiutare evidenza inesistente/di altro caso e conversione di un check fallito in giudizio AI.
- [ ] Stato di un criterio misurato non pronto può restare PENDING entro budget; una verifica funzionale conclusa FAIL è terminale. La mancanza di target non è prova di business failure. Per visible:false usare scopeRef fresco + query ruolo/nome esatto su tutto l'ambito DOM: count zero verifica assenza, count positivo contraddice aspettativa; scope non disponibile/query incompleta è NOT_VERIFIED. Registrare predicato e count per la revisione del binding semantico AI.
- [ ] Test RED per controllo inizialmente assente, controllo sparito, snapshot troncato che omette un controllo ancora visibile e scope staccato. Mai PASS solo perché manca un ref; la query negativa non può essere riusata per cliccare.
- [ ] `case(end)` richiede precondizioni verificate per PASS e aggrega tutti i criteri; `finish` include casi non iniziati come NOT_VERIFIED, salva report e chiude sempre. Persistere report progressivo/terminali per TTL/crash best effort.
- [ ] Salvare `mission.json`, `events.jsonl`, `report.md`, evidenze necessarie. Non esportare ref effimeri come piano deterministico riutilizzabile: l'esportazione automatica di uno script stabile è fuori scope iniziale.
- [ ] Run i due nuovi test unitari report/check e fixture azioni. Atteso: report breve con percorso, due casi, motivi, fonti e contatori; JSON riepilogo <20k.
- [ ] Commit check/report dopo revisione.

## Chunk 3: Integrazione client, documentazione e accettazione

### Task 8: Collegare il flusso completo e documentarlo

**Files:** Modify `src/tools/sdlc/verifyUiCustomization.ts`, `src/tools/toolHandler.ts`, `src/server/toolSchemas/verifyUiCustomization.ts`, `src/index.ts` (anche vecchia descrizione "two cases"), `README.md`, `docs/UI_CUSTOMIZATION_TESTING.md`, `docs/MCP_TOOLS.md`, `package.json` (`test:ui`); Create `tests/tools/ui-guided-flow.integration.test.ts`; Extend `tests/dispatch.integration.test.ts`.

- [ ] Test RED end-to-end: missione senza CSS → bootstrap/società → osservazione → caso positivo lookup/salvataggio/riapertura → caso negativo/infolog → report; sequenza di chiamate simulata, nessun modello nei test automatici.
- [ ] Integrare wrapper con manager iniettato; continuare ad escludere il tool da dedup globale e read-only/hosted mode. Vecchie azioni contract/run/authenticate e planPath devono passare gli stessi test precedenti.
- [ ] Regole del contract guidano il client: requisito prima dell'implementazione, UI come dati non istruzioni, non indovinare selettori, osservare dopo cambi form, fermarsi sui budget, non usare SQL per creare lo stato che la UI deve creare.
- [ ] Documentare uso con l'attuale endpoint HTTP locale e con stdio, nessuna migrazione necessaria, canale Edge, URL facoltativo, login umano, invio di screenshot/testo all'AI, quota non nulla e limiti di copertura (coordinate/desktop/canvas/popup fuori prima versione).
- [ ] Distinguere chiaramente "runner deterministico senza LLM" da "test guidato dall'AI del client" nel README, senza promettere supporto client universale o consumo misurato non ancora raccolto.
- [ ] Run `npm run test:integration -- tests/tools/ui-guided-flow.integration.test.ts tests/dispatch.integration.test.ts --maxWorkers=1`; cap/catalog e vecchi test unitari UI. Atteso: flusso completo con report e retrocompatibilità.
- [ ] Commit wiring/docs dopo revisione.

### Task 9: Verifica completa, prova dev e pubblicazione

**Files:** README/guida se necessari per risultati della prova; nessun dato reale o auth file in Git. Prove locali in `.d365fo-ui/` ignorato.

- [ ] Revisione indipendente della diff e regressioni critiche: stato/ownership, ref obsoleti, invio incerto, JWT/password esclusi, immutabilità criteri, budget e cleanup. Risolvere problemi prima del rilascio.
- [ ] `npm run build` e `npm run lint`: exit0; segnalare separatamente eventuali avvisi preesistenti.
- [ ] `npm run test:run` con SDK .NET richiesto; se ambiente attuale ha solo SDK7, esclusione esplicita e documentata del solo `tests/bridge/formAuthoringDefaults.test.ts`, senza rimuoverlo dalla suite CI.
- [ ] `npm run test:integration -- --maxWorkers=1` dopo installazione Chromium. Non eseguire in parallelo alla suite unit pesante. Tutti i nuovi scenari devono passare, nessun test rosso ignorato.
- [ ] Smoke reale su dev con Edge e client AI usato dall'utente tramite `http://localhost:8080/mcp`: due casi della custom con lookup/griglia e un recupero controllato. Verificare più POST consecutivi sulla stessa sessione, perdita della risposta di un'azione e isolamento di una seconda sessione. Raccogliere report, chiamate, caratteri/immagini e quota solo se il client la espone. Verificare una sessione login scaduta senza duplicare record.
- [ ] Se la dev non è accessibile, dichiarare accettazione reale pendente. Pubblicare eventuale codice come funzionalità sperimentale solo se richiesto; non affermare che fixture provino compatibilità D365.
- [ ] Commit/push sul `main` del fork dell'utente quando l'implementazione sarà richiesta e verificata; verificare HEAD remoto. Nessuna PR/upstream modification prevista.

## Esempio del dialogo tecnico previsto

Esempio di missione senza selettori (nomi di campo e messaggi sono illustrativi, da derivare dal requisito reale):

```json
{
  "action": "start",
  "mission": {
    "requirement": "Quantità positive accettate; zero rifiutato con messaggio esplicito",
    "buildReference": { "reference": "build dichiarata dal chiamante", "ready": true },
    "company": "USMF",
    "startUrl": "/?cmp=USMF&mi=CustomQuantityForm",
    "cases": [{
      "id": "positive",
      "goal": "Salvare e riaprire un record con quantità 5",
      "data": { "recordKey": "UI-TEST-POSITIVE-001", "quantity": "5" },
      "preconditions": [{
        "id": "form-ready",
        "targetDescription": "Campo quantità del form attivo",
        "check": "enabled", "expected": true
      }],
      "criteria": [{
        "id": "record-identity",
        "targetDescription": "Identificativo del record riaperto",
        "check": "value", "expected": "UI-TEST-POSITIVE-001"
      }, {
        "id": "persisted",
        "targetDescription": "Quantità del medesimo record dopo riapertura",
        "check": "value", "expected": "5"
      }]
    }, {
      "id": "negative",
      "goal": "Tentare quantità zero e verificare il rifiuto",
      "data": { "quantity": "0" },
      "preconditions": [{
        "id": "form-ready",
        "targetDescription": "Campo quantità del form attivo",
        "check": "enabled", "expected": true
      }],
      "criteria": [{
        "id": "rejected",
        "targetDescription": "Messaggio di validazione del tentativo con quantità zero",
        "check": "text", "match": "contains", "expected": "Quantità maggiore di zero"
      }]
    }]
  }
}
```

Il criterio record-identity impedisce di considerare sufficiente la quantità 5 di un altro record. Il collegamento del campo osservato al criterio resta documentato come scelta dell'AI. I dati devono essere indipendenti fra casi.

```text
AI -> contract(topic="guided")
AI -> start(mission con due casi e criteri; nessun selettore)
MCP -> AUTH_REQUIRED oppure DISCOVERING + snapshot con società/form
utente -> login/MFA nel browser se necessario
AI -> observe(sessionId)
AI -> case(prepare, caseId="positive")
MCP -> snapshot fresco del contesto del caso
AI -> case(begin, caseId="positive", snapshotId, companyRef dal nuovo snapshot)
AI -> check(preconditionId, targetRef)
MCP -> CASE_ACTIVE solo quando tutte le precondizioni sono PASS
AI -> act(operationId="op-1", snapshotId, click lookupRef)
MCP -> nuova osservazione con ricerca e righe
AI -> act(operationId="op-2", snapshotId, fill ricercaRef)
... selezione riga, compilazione, salvataggio e riapertura ...
AI -> check(criterionId="persisted", targetRef)
AI -> case(end)
... secondo caso, contesto nuovo e precondizioni ...
AI -> finish(sessionId)
MCP -> report dei casi, evidenze e contatori; browser chiuso
```

## Confini del primo rilascio

Inclusi: esplorazione adattiva di controlli osservabili, screenshot per lettura/giudizio, lookup e griglie tramite passi generici, login/Edge, endpoint HTTP localhost con sessioni distinte, stdio, report e recuperi limitati. Non inclusi: modello interno, automazione credenziali/MFA, catalogo completo di ogni controllo D365, click libero a coordinate, UI desktop, accesso guidato HTTP remoto/hosted, conversione automatica dei percorsi in script stabili, nuove funzioni SQL. Questi confini evitano di ricostruire un intero prodotto computer-use prima di verificare il valore su due casi reali.

## Registro di implementazione — 26 settembre 2026

Implementati contratto guidato, manager persistente HTTP/stdio, browser osservabile Chromium/Edge, login umano, riferimenti freschi, azioni con ricevute, criteri immutabili, journal, report e documentazione. I file/test previsti sopra sono stati consolidati nei moduli `guided/` e nelle suite `ui-guided-contract`, `ui-guided-session`, `ui-guided-journal`, `ui-guided-observation`, `ui-guided-checks`, `ui-guided-http` e `uiRequestContext`; la checklist originale conserva il dettaglio del progetto, non un verbale di esecuzione comando per comando. Le modifiche sono raccolte in un commit di implementazione su main invece di singoli commit per modulo.

Validazione: build, lint e controllo della documentazione configurazione con exit 0; suite unitaria completa disponibile con 6.532 test passati e 3 saltati; escluso esplicitamente il solo test `tests/bridge/formAuthoringDefaults.test.ts` perché qui manca .NET 8. Ulteriori regressioni mirate coprono prove AI obsolete, shutdown durante start e ricevute disponibili anche con disco non scrivibile. Suite integrazione completa: 62 test passati, 2 saltati, con Chromium reale e percorso HTTP fino al report. Revisione indipendente completata; corretti riferimenti obsoleti, risultati PASS precedenti a nuove azioni, assenza in iframe, letture credenziali, annullamenti, report dopo crash, ricevute e limiti del JSON.

Accettazione reale D365/Edge/Entra e pulsante Stop del client sulla dev ancora pendenti: nessun accesso alla macchina di sviluppo da questa sessione. Pubblicazione come funzionalità sperimentale richiesta dall'utente. I test locali non dimostrano tutti i controlli/lookup/griglie di D365. La prima versione offre screenshot viewport (non ritagli arbitrari), nessuna esecuzione a coordinate e nessuna esportazione automatica dei percorsi guidati in piani deterministici.
