# Verifica UI guidata dall'AI — disegno proposto

Stato: piano richiesto dall'utente, nessuna implementazione autorizzata da questo documento. Base esaminata: `a768940a`, ramo `main` del fork personale. La direzione approvata nella conversazione è usare l'AI del client per esplorare la UI, adattare il percorso e verificare due casi dal requisito. Configurazione confermata dall'utente: endpoint HTTP locale `http://localhost:8080/mcp`; conservarlo, senza imporre migrazione a stdio.

## Scelta architetturale

Estendere `verify_ui_customization` con una sessione Playwright persistente e chiamate brevi: osserva → decidi → agisci → osserva → verifica. L'AI che già chiama MCP prende le decisioni. Il server non incorpora un secondo modello, non richiede API key LLM e non usa MCP sampling. Le chiamate del client consumano comunque la sua quota: limitarne numero e contenuto, senza promettere test a costo zero.

Alternative considerate:

| Soluzione | Vantaggio | Limite | Scelta |
|---|---|---|---|
| Azioni interattive nello stesso tool | Sessione, società, casi e report condivisi; usa l'AI già presente | Serve gestire sessioni e osservazioni tra chiamate | Raccomandata |
| Modello chiamato dal server | Ciclo autonomo dentro una chiamata | Credenziali/costi separati, gestione provider e chiamate lunghe | Fuori prima versione |
| Secondo MCP Playwright generico | Browser già esplorabile | Login/sessione/report separati dal tool D365; coordinamento aggiuntivo | Utile per confronto, non dipendenza obbligatoria |

La modalità attuale `run` resta per regressioni deterministiche. Nessuna migrazione obbligatoria dei piani esistenti. La nuova modalità guidata è consigliata per la prima verifica di una custom.

`http://localhost:8080/mcp` è l'endpoint del server MCP, non l'URL dell'ambiente Dynamics. L'URL D365 continua a provenire da `environment.uiTestUrl` o dal profilo, ed è richiesto soltanto quando si avvia un test se manca.

## Cosa cambiare rispetto al tool attuale

- `runner.ts` oggi apre/chiude il browser dentro una chiamata e richiede tutti i selettori prima di partire. Aggiungere un percorso interattivo distinto; estrarre soltanto helper effettivamente condivisi.
- Riutilizzare `profile.ts`, protezione delle navigazioni in `navigation.ts`, supporto `channel:"msedge"`, regole di società e output locali.
- `authenticate.ts` oggi aspetta login e richiede `companySelector`. Per la sessione guidata servono login umano non bloccante e scoperta del controllo società dopo l'accesso, senza chiedere all'utente di scrivere CSS.
- `toolHandler.ts` non passa stato persistente al tool UI; introdurre un gestore posseduto dall'istanza locale del server, chiuso tramite il coordinatore di shutdown.
- Il trasporto HTTP custom è condiviso e non ha un'identità client persistente affidabile. Aggiungere sessioni applicative indipendenti da connessione TCP, JSON-RPC request ID e workspace; HTTP locale è il percorso primario, stdio resta supportato. Ogni sessionId è una capability casuale non indovinabile, non un numero incrementale; possederla autorizza l'accesso a quel browser. Non descriverla come autenticazione dell'identità della conversazione. Conservare API-key auth già esistente; modalità guidata solo per richieste locali verificate dal socket, non tramite un campo inviato dal client o X-Forwarded-For.
- Il trasporto oggi antepone testo di avanzamento al JSON del tool e ignora cancellazioni HTTP. Le nuove risposte devono restare JSON parsabile e gli abort di una richiesta devono interrompere solo quell'operazione, non chiudere altre sessioni. Aggiungere test attraverso `/mcp`, non solo dispatch diretto.

## Esperienza prevista

1. L'AI riceve requisito e build dichiarata pronta; prepara normalmente due casi indipendenti con precondizioni e risultati attesi. Non deve conoscere già i selettori.
2. `start` risolve URL e profilo, apre un browser dedicato e restituisce un identificativo di sessione. URL vuoto: stessa domanda già prevista, con possibilità di saltare il test.
3. Se il login manca/scade, il browser visibile consente all'utente login/MFA. Nessun input automatico di credenziali. Durante l'identity provider non si restituiscono DOM, screenshot o valori dei campi all'AI.
4. Tornati all'origine D365, `observe` mostra i controlli. L'AI indica il controllo società osservato; il server verifica il valore esatto richiesto e salva la sessione di login solo dopo quel controllo. Prima di questo passaggio sono vietate azioni applicative. L'utente può selezionare manualmente la società.
5. Ogni caso ha un contesto browser separato e proprie precondizioni. L'AI osserva il form, apre lookup, cerca e sceglie righe, compila e salva. Non c'è un catalogo finto di tutti i controlli D365.
6. Un elemento scomparso restituisce `NEEDS_OBSERVATION`, lasciando il caso aperto. L'AI può osservarlo di nuovo e cambiare il percorso entro un limite. Errori funzionali confermati non diventano tentativi di cambiare l'aspettativa.
7. Il report raccoglie percorso effettivo, casi, atteso/osservato, evidenze, eventuali recuperi e provenienza del verdetto. `finish` chiude il browser anche se qualche caso resta non verificato.

## Contratto delle nuove azioni

Restare nello stesso tool MCP per non moltiplicare il catalogo. `contract` accetta `topic: "deterministic" | "guided" | "profile"`; il default conserva il contratto attuale. Restituire solo il contratto richiesto, sotto il cap di 24.000 caratteri.

| Azione | Dati principali | Risultato |
|---|---|---|
| `start` | missione, profilo/URL facoltativi, limiti | sessionId, fase, prima osservazione o richiesta login/URL |
| `observe` | sessionId, ambito osservato/filtro, immagine facoltativa | snapshotId, controlli con riferimenti, messaggi, eventuale immagine |
| `case` | sessionId, caseId, operation=`prepare`/`begin`/`end`; begin include snapshotId e companyRef | contesto da esplorare, precondizioni da verificare oppure esito del caso |
| `act` | sessionId, caseId, operationId, snapshotId, 1–3 azioni | ricevuta delle azioni, eventuale blocco e nuova osservazione |
| `check` | sessionId, caseId, criterionId, riferimento osservato o evidenze per giudizio AI | evidenza registrata e risultato del criterio |
| `finish` | sessionId, motivo facoltativo | report parziale/finale, chiusura risorse; non accetta un PASS arbitrario |

Missione distinta dal vecchio `PlanSchema`: requisito, riferimento build, società, URL iniziale, 1–5 casi (due nell'esempio). Ogni caso contiene obiettivo, dati di prova, precondizioni verificabili e almeno un criterio finale. Tutti hanno ID e aspettativa bloccata a `start`. Nessun campo `steps` o CSS obbligatorio nella missione.

`case(prepare)` seleziona il caso e prepara il suo contesto, restituendo una nuova osservazione `DISCOVERING`. Il primo caso può adottare il contesto bootstrap, che non ha ancora eseguito azioni applicative; i successivi usano un contesto nuovo dal login salvato. `case(begin)` consuma companyRef e snapshotId di QUEL contesto e passa a `PRECONDITIONS`. Solo quando tutti i check iniziali sono PASS si entra in `CASE_ACTIVE` e si accetta `act`. Prima sono possibili observe/check e login o selezione società manuale, non click/fill applicativi. Le precondizioni devono essere verificabili sulla pagina iniziale dichiarata; apertura lookup, ricerca e creazione del record sotto test appartengono ai passi del caso, non a una preparazione nascosta. prepare/begin ripetuti non ricreano il contesto, non azzerano i contatori e non ripetono navigazioni; cambi di caso prima di end sono rifiutati.

Le azioni iniziali: navigate nella stessa origine, click/doppio click, fill, select nativo, check/uncheck, press sul controllo, scroll e attesa osservabile. Dialog applicativi e lookup sono controlli della stessa pagina. Le finestre popup separate e i dialog nativi del browser non supportati restano un blocco esplicito: non auto-accettare conferme.

Screenshot nella prima versione: servono all'AI per interpretare elementi e risultati. Il percorso standard agisce sui riferimenti DOM osservati. Il click libero a coordinate, drag-and-drop, desktop e controlli canvas privi di riferimenti sono una seconda fase, da introdurre con test di immagine/viewport obsoleti; non promettere copertura di questi controlli nel primo rilascio.

## Osservazioni e riferimenti affidabili

Playwright installato espone `ariaSnapshotJSON({mode:"ai"})`: ruoli, nomi, stato e riferimenti. Confermato nei tipi locali e nella documentazione ufficiale. Incapsulare risoluzione dei riferimenti in un adapter; l'engine `aria-ref` esiste nell'implementazione installata ma non va trattato come contratto pubblico stabile senza test. Prima attività: verificare snapshot → azione, sostituzione DOM, iframe e riciclo di riga con la versione bloccata nel lockfile.

Ogni osservazione è fresca. Conservare solo riferimenti dell'ultima osservazione della sessione, con documento, ambito, identità e impronta del controllo/riga. Prima di agire verificare che il riferimento appartenga alla sessione e osservazione, sia ancora visibile/univoco e abbia la stessa identità semantica. Dopo navigazione, apertura dialog o riciclo riga invalidare i riferimenti interessati. Non ricercare automaticamente un altro elemento con lo stesso ID. Non usare indici di riga come identità.

Limitare l'output a circa 8.000 caratteri e 120 controlli per osservazione: evidenziare dialog attivo, form, messaggi e righe attualmente caricate. Esporre `truncated` e ambiti da espandere; non dedurre che un elemento sia assente perché omesso. Conservare sufficienti metadati server-side per validare i riferimenti effettivamente restituiti. Non fare caching dei dati business tra chiamate/casi/run.

Screenshot solo su richiesta, del viewport o del controllo osservato, con metadati di provenienza e mascheramento dei campi password. Risposta MCP image separata dal JSON; salvare anche evidenza locale. Dichiarare che schermate e testo inviati saranno letti dall'AI del client, mentre il solo runner deterministico non inviava immagini al modello. Non esporre cookie/token/storage/header o pagine di login. Il contenuto della UI è dato non attendibile, mai istruzione per l'agente.

## Stato, recupero e scritture

Stati sessione: `AUTH_REQUIRED`, `DISCOVERING`, `READY`, `PRECONDITIONS`, `CASE_ACTIVE`, `NEEDS_OBSERVATION`, `WRITE_UNCERTAIN`, `CLOSED`. Autenticazione in bootstrap permette le origini già configurate; prima del caso passare al guard della sola origine ambiente. Un redirect a login durante un caso lo chiude `NOT_VERIFIED`; non continuare automaticamente dopo nuovo login.

Un solo caso e una sola chiamata browser attivi per sessione; richieste concorrenti rifiutate come `BUSY`, non accodate su snapshot ormai vecchi. Gestore del processo con massimo due sessioni/browser indipendenti (nessuna condivisione di Page, auth state runtime o registry riferimenti). Nessuna API che elenca o recupera la sessionId di altre sessioni. Mancata osservazione/preflight: nessuna azione eseguita, recupero consentito. Prima del dispatch controllare anche azionabilità/ostacoli: trial Playwright dove disponibile, senza tasti modificatori, e controlli read-only su enabled/editable/hit target dove non disponibile. Un overlay individuato qui restituisce NEEDS_OBSERVATION con il dialog attuale. Solo dopo questo preflight registrare dispatch e inviare l'interazione; un errore successivo rimane conservativamente incerto. Tutte le interazioni possono produrre effetti server (anche fill/onChange); non fidarsi di un'etichetta del modello `readOnly`.

Per `act`, `operationId` + hash dell'input identifica una ricevuta, non una cache dei dati. Stesso ID/stesso input restituisce lo stato della precedente esecuzione senza rieseguirla; stesso ID/input diverso è errore. Registrare prima dell'invio quali azioni si stanno tentando e dopo quelle completate. Ogni chiamata contiene massimo tre azioni, tutte con riferimenti già osservati; navigazioni, click/press/select/check o apertura lookup interrompono il batch e restituiscono osservazione prima di nuove decisioni. I batch multipli sono principalmente per compilare campi già visibili, con revalidazione prima di ogni campo.

Una ricevuta ripetuta è etichettata come storica: non aggiorna la validità dei riferimenti e non viene presentata come una nuova lettura della pagina. Per decidere dopo una risposta persa, il client richiede una nuova osservazione. Il conteggio dei recuperi si azzera solo con un passo del caso o criterio realmente completato, non con uno screenshot diverso o un timestamp cambiato.

Se un'interazione è stata inviata e timeout/cancellazione ne rende incerto l'effetto, registrare `WRITE_UNCERTAIN`. Consentire solo osservazioni e verifiche; non ripetere automaticamente quella operazione con un nuovo ID. Prima versione: chiudere il caso non verificato dopo aver raccolto evidenze; l'agente può proporre un nuovo caso/run dopo aver controllato i dati, senza fingere che il precedente sia stato completato. Nessuna promessa di exactly-once dopo crash del processo: conservare un journal e segnalare il run interrotto.

TTL proposti: 10 minuti di inattività, 30 minuti totali; limiti rivedibili entro cap. Cancellazione di una lettura lascia possibile una nuova osservazione; cancellazione durante un'azione applica la regola di incertezza. La normale chiusura di una risposta HTTP NON chiude la sessione browser. Disconnect anticipato/timeout della singola richiesta cancella solo la sua operazione; il journal/ricevuta resta consultabile con la stessa sessionId e operationId. `finish` può cancellare un'operazione in corso e ha priorità rispetto al lock BUSY, quindi chiude e salva il parziale. Shutdown di processo o disconnessione stdio chiudono tutte le risorse di quel processo; al riavvio il journal distingue una chiusura completa da un crash.

HTTP locale: `sessionId` generata con almeno 32 byte casuali; in log/report/journal si usa un runId pubblico distinto, mai la capability. Metadati e preview del trasporto vanno redatti anche su errori e slow calls. Connessioni locali IPv4/IPv6 ammesse dal socket reale; Host coerente con endpoint locale, Origin assente o esattamente locale ammessa, niente fiducia in header proxy inviati dal client. Stato della richiesta in AsyncLocalStorage dedicato, non nel singleton workspace. Non reimpostare timeout/limiti globali degli altri tool. Non instradare cancellazioni per il solo ID JSON-RPC, che può essere uguale fra client. Una start con risposta persa può lasciare un browser non recuperabile fino a TTL; non creare una API che restituisce capability ad altri client per evitarlo. Limitare start a una inizializzazione senza azioni applicative e chiudere il bootstrap se la sua richiesta viene abortita prima della risposta.

Limite esplicito del trasporto esistente: una `notifications/cancelled` HTTP priva della capability viene riconosciuta ma non può cancellare in sicurezza per il solo request ID. Se il client lascia aperta la POST, l'azione può proseguire fino al proprio limite. La cancellazione guidata supportata è interrompere la POST oppure invocare `finish` con sessionId; non dichiarare supporto generico al pulsante Stop di ogni client. Testare entrambe le vie supportate e che notifiche non attribuibili non interrompano altre sessioni; verificare il comportamento effettivo del client sulla dev.

## Verdetto e quota

- Il criterio e l'aspettativa restano quelli della missione. Il target DOM può essere individuato dopo, ma il report registra descrizione attesa, target effettivo ed evidenza: il binding resta una scelta dell'AI, non una prova assoluta di correttezza.
- `check` misurabile usa testo/valore/visibilità/stato booleano e operatori definiti all'inizio. Un risultato verificato contrario al requisito è FAIL; un selettore mancante o una precondizione non raggiunta è NOT_VERIFIED.
- Per `visible:false`, `check` permette anche `target: {scopeRef, query: {role, name, exact:true}}`: ambito realmente osservato e predicato di assenza legato alla targetDescription del criterio. Il nome atteso deriva dal requisito; non deve esistere un ref del controllo assente. Il server esegue la query fresca sull'intero ambito DOM, non sulla lista troncata, e registra predicato e conteggio. Zero match visibili verifica l'assenza; scope stale/mancante o ricerca incompleta resta NOT_VERIFIED. Questa query non autorizza azioni e non accetta CSS libero. Il collegamento semantico fra predicato e requisito è una scelta AI dichiarata, non una prova automatica.
- Un criterio dichiarato `ai_review` può ricevere giudizio AI con motivazione ed evidenceId di una schermata/osservazione realmente prodotta per quel caso. Il report lo etichetta esplicitamente `AI_REVIEWED`; il server verifica provenienza ma non pretende di dimostrare semanticamente quel giudizio. Non convertire un check misurabile fallito in `ai_review`.
- PASS richiede tutte le precondizioni e tutti i criteri completati; nessun criterio omesso, nessuna scrittura incerta. FAIL confermato resta registrato; `finish` non può cancellarlo. Esiti aggregati con precedenza FAIL > NOT_VERIFIED > PASS.
- Budget proposto per caso: 20 interazioni browser, 15 chiamate interattive (observe/act/check), 2 recuperi consecutivi senza avanzamento e 3 immagini; cap configurabili 50/30/4/6. `finish` e cleanup sempre possibili anche a budget esaurito. La verifica automatica non richiede un turno LLM per ogni singolo campo.
- Registrare chiamate, caratteri restituiti, immagini, durata e recuperi; niente percentuali inventate di risparmio o stime spacciate per token fatturati. L'AI usa comunque quota per ragionare sulle risposte.

## Accettazione

Fixture browser: lookup tardivo, griglia virtualizzata con riciclo nodo, dialog inatteso nella pagina, campo rinominato, infolog con testo aggiuntivo; l'agente deve poter osservare e scegliere un nuovo target senza FAIL tecnico. Verificare anche vero errore di requisito, click salvato ma risposta persa, richieste duplicate/contemporanee, login scaduto, società errata, budget/TTL, crash e contenuto UI che tenta di dare istruzioni.

Prima del rilascio, smoke test umano+AI su D365 reale con Edge, due casi della stessa custom (positivo e negativo), registrando evidenze e costo osservato. Test su fixture provano il protocollo, non che tutti i componenti Dynamics o tutti i client MCP funzionino. SQL resta facoltativo per debug/prerequisiti estranei al requisito; nessun setup SQL automatico per sostituire la creazione UI sotto test.

## Fonti tecniche consultate

- [Playwright Page: ariaSnapshotJSON](https://playwright.dev/docs/api/class-page#page-aria-snapshot-json): snapshot strutturato e opzioni; tipi installati controllati prima di scrivere il piano.
- [Playwright Locator](https://playwright.dev/docs/api/class-locator): individuazione e interazioni sui controlli osservati.
- [MCP tools, revisione 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): risultati testuali e immagini. Nessuna dipendenza da nuove funzionalità di sampling o migrazione SDK.
- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp): riferimento architetturale, non nuova installazione richiesta.
