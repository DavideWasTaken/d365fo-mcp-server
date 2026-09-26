# Verifica UI delle custom D365FO — prima versione

## Obiettivo concordato

Aggiungere al MCP esistente un solo tool, `verify_ui_customization`, che esegua nel browser due casi legati al requisito della custom appena sviluppata e produca un report breve. Nessun Jev o altro modello giudice. Questo documento descrive il progetto della prima versione. Il runner è ora implementato; uso e limiti effettivi sono documentati in `docs/UI_CUSTOMIZATION_TESTING.md`. La validazione su D365FO reale resta da eseguire.

## Flusso

1. L'agente usa gli strumenti MCP esistenti per produrre il codice della custom.
2. Build, eventuale sincronizzazione e pubblicazione rendono la modifica disponibile nell'ambiente D365FO di test. La sola creazione del codice non autorizza un esito positivo.
3. L'agente prepara una sola volta due casi dal requisito originale: percorso principale e caso negativo o limite più rilevante. Ogni caso contiene dati, passi e verifiche esplicite del risultato atteso; il codice generato non è la fonte del comportamento atteso.
4. L'agente richiama `verify_ui_customization` passando i casi. Il runner Playwright esegue i passi e le verifiche senza chiamate a modelli durante l'esecuzione.
5. Il tool restituisce il riepilogo e salva un report Markdown locale. L'agente può intervenire successivamente su un errore, senza un ciclo automatico di correzioni e riesecuzioni.

## Contratto del tool

Input: riferimento al requisito e alla revisione/build da verificare, profilo locale dell'ambiente, società D365FO prevista, pagina iniziale e due casi. Ogni caso specifica nome, precondizioni, dati di test, sequenza di azioni e almeno una verifica osservabile collegata al requisito.

Azioni iniziali supportate: navigazione nell'ambiente configurato, clic, compilazione, selezione, tasti e attesa di un elemento. Verifiche: visibilità, testo, valore di campo e stato abilitato/disabilitato. Usare selettori verificati sul DOM reale, con ambito e corrispondenza univoca; non inventarli dai soli metadati X++. Per i salvataggi, quando pertinente, riaprire il record e verificare il valore persistito dalla UI.

Il piano deve già contenere passi e selettori eseguibili. Se serve esplorare la UI per prepararli, questo avviene separatamente e può consumare quota. Il runner non interpreta autonomamente requisiti in linguaggio naturale e non genera selettori con un modello.

Output: esito complessivo, esito per caso, passi realmente eseguiti, atteso/osservato, motivo dell'eventuale blocco, durata e percorso del report. Lo stato della build è un prerequisito dichiarato dal chiamante e riportato come tale, non una certificazione effettuata dal browser.

## Componenti e integrazione

- Schema e handler MCP seguono `docs/NEW_TOOL_CHECKLIST.md`; un tool nuovo e schema compatto, con contratto dettagliato nella documentazione.
- Runner Playwright locale: traduce azioni strutturate in interazioni e raccoglie osservazioni. Nessun codice JavaScript arbitrario nel piano di test.
- Report formatter: genera Markdown dai risultati strutturati, senza LLM.

Il profilo locale indica URL consentito, cartella artefatti e sessione browser autenticata. Verificare nella UI le precondizioni, compresa la società attiva; controllare l'ambiente consentito anche dopo i redirect. Login/MFA richiedono la normale sessione dell'utente; se non disponibile il tool restituisce NON VERIFICATO. Non importa credenziali dal browser personale. Configurazioni, sessioni e risultati con dati reali restano locali ed esclusi da Git.

## Limiti ed esiti

Prima versione: esattamente due casi, al massimo 20 azioni per caso, 15 secondi per attesa e 120 secondi per caso. Nessun retry completo automatico o espansione della suite. I due casi devono essere indipendenti e indicare dati dedicati già disponibili; la generazione generalizzata e la pulizia automatica dei dati sono escluse.

- PASS: tutte le verifiche previste del caso sono soddisfatte.
- FAIL: il risultato funzionale osservato contraddice quello atteso.
- NON VERIFICATO: login assente, ambiente/build non pronti, precondizione mancante, selettore ambiguo o errore tecnico che impedisce la verifica. Un semplice timeout di navigazione non dimostra un difetto della custom.

Una verifica funzionale fallita produce FAIL solo se pagina, dati e precondizioni necessari sono stati raggiunti. Il caso si ferma al primo errore; il secondo viene comunque eseguito se le sue precondizioni sono soddisfatte e l'ambiente è utilizzabile. Esito complessivo: FAIL se almeno un caso fallisce, altrimenti NON VERIFICATO se un caso non è verificabile, altrimenti PASS. Mostrare sempre anche entrambi gli esiti individuali.

Il verdetto riguarda soltanto i due scenari provati. Requisiti non osservabili con le verifiche disponibili vanno segnalati come non coperti. Screenshot locale solo sul punto di errore, se acquisibile; nessun invio di immagini al modello di default.

## Report semplice

Intestazione: custom/requisito, revisione dichiarata, ambiente/società, data, durata, esito complessivo.

| Caso | Giro realmente effettuato | Atteso | Osservato | Esito |
|---|---|---|---|---|
| Principale | Passi completati in ordine | Criterio del requisito | Evidenza raccolta | PASS / FAIL / NON VERIFICATO |
| Negativo o limite | Passi completati in ordine | Criterio del requisito | Evidenza raccolta | PASS / FAIL / NON VERIFICATO |

Chiudere con eventuale passo di arresto, collegamento allo screenshot locale e criteri non coperti. Nessun log esteso nel messaggio MCP salvo richiesta.

## Validazione dell'implementazione

Test mirati per limiti del piano, aggregazione degli esiti e distinzione tra errore funzionale e blocco tecnico. Una piccola pagina locale controllata verifica che il runner interagisca e produca osservazioni reali. Typecheck e controlli richiesti dal repository verificano l'integrazione MCP. Prima di dichiarare compatibilità operativa con D365FO, eseguire i due casi su una custom effettivamente pubblicata in un ambiente D365FO: la sola fixture locale non basta.

## Esclusioni

Nessun modello giudice, conversione RSAT, suite di regressione estesa, dashboard, test di performance, self-healing dei selettori o supporto universale di tutti i controlli D365FO nella prima versione. Controlli complessi non supportati devono produrre un blocco esplicito, non un PASS.

## Decisione di implementazione

La prima versione blocca tutti i redirect HTTP di navigazione, anche sullo stesso dominio, con NON VERIFICATO e istruzione di usare l’URL finale e aggiornare la sessione salvata. Questo limite esplicito evita che una catena di redirect raggiunga un altro ambiente prima del controllo. Le normali risorse della pagina (ad esempio script CDN) sono consentite; il vincolo riguarda la navigazione.
