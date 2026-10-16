(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) {
    window.console.error("[hermes-logs-viewer] __HERMES_PLUGIN_SDK__ missing");
    return;
  }
  var R = SDK.React;
  var hooks = SDK.hooks;
  var useState = hooks.useState;
  var useEffect = hooks.useEffect;
  var useRef = hooks.useRef;
  var useCallback = hooks.useCallback;
  var fetchJSON = SDK.fetchJSON;

  var API = "/api/plugins/hermes-logs-viewer";
  // Boards, profiles, task creation and the log itself are served by the
  // bundled kanban plugin, which is mounted at process start and therefore
  // already live. This plugin only owns what the bundled one has no route for
  // (a flat task list across every board, and the live comment thread), so the
  // panel never depends on this plugin's own backend routes going live — those
  // would need a dashboard restart, which is not always available to us.
  var KANBAN_API = "/api/plugins/kanban";
  // Bytes of the log shown when the file is not expanded. The bundled route
  // returns the whole file when `tail` is omitted, which is what "развернуть"
  // asks for; logs rotate at 2 MiB, so an untruncated read stays bounded.
  var TAIL_BYTES = 512 * 1024;
  var MAX_LINES = 3000;
  var MAX_LINES_FULL = 40000;  // cap once the log is expanded from the top
  var TASK_POLL_MS = 2000;
  var LOG_POLL_MS = 1200;
  var BOARDS_POLL_MS = 15000;   // the board list changes rarely
  var PROFILES_POLL_MS = 30000; // installed profiles change even more rarely
  var FOLLOW_MS = 500;          // autoscroll watchdog cadence
  var BOTTOM_THRESHOLD = 80; // px from the bottom that still counts as "at bottom"
  var ALL_BOARDS = "";       // board-filter value behind the "Все доски" option
  var BOARD_KEY = "hlv.board";      // localStorage key for the board filter

  var STATUS_LABEL = {
    running: "running",
    scheduled: "scheduled",
    ready: "ready",
    blocked: "blocked",
    review: "review",
    triage: "triage",
    todo: "todo",
    done: "done",
    archived: "archived",
  };

  // Every status gets its own class so each badge is tinted — the colours live
  // in style.css and mirror the bundled Kanban plugin's column dots.
  function statusClass(s) {
    switch (s) {
      case "triage": return "hlv-status triage";
      case "todo": return "hlv-status todo";
      case "scheduled": return "hlv-status scheduled";
      case "ready": return "hlv-status ready";
      case "running": return "hlv-status running";
      case "blocked": return "hlv-status blocked";
      case "review": return "hlv-status review";
      case "done": return "hlv-status done";
      case "archived": return "hlv-status archived";
      default: return "hlv-status idle";
    }
  }

  function timeAgo(ts) {
    if (!ts) return "";
    var d = Date.now() / 1000 - ts;
    if (d < 0) d = 0;
    if (d < 60) return Math.floor(d) + "s";
    if (d < 3600) return Math.floor(d / 60) + "m";
    if (d < 86400) return Math.floor(d / 3600) + "h";
    return Math.floor(d / 86400) + "d";
  }

  // Byte counts, shown next to the лог/комментарии tabs. Exact bytes with a
  // thin-space thousands separator — a log window is only meaningful against
  // the file's true size, and a rounded "1.1 МБ" cannot be compared with a
  // byte offset. fmtHuman is the same number for a human, kept in the tooltip.
  var NBSP = " ";

  function fmtBytes(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) + NBSP + "Б";
  }

  function fmtHuman(n) {
    n = Math.max(0, Number(n) || 0);
    if (n < 1024) return n + " Б";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " КБ";
    return (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + " МБ";
  }

  // UTF-8 byte length of a string. The log route reports the file size in
  // bytes while the content arrives as text, so the window's start offset can
  // only be derived by measuring what actually came back.
  var ENCODER = typeof TextEncoder === "function" ? new TextEncoder() : null;

  function byteLen(str) {
    if (!str) return 0;
    if (ENCODER) return ENCODER.encode(str).length;
    // Fallback for a browser without TextEncoder: count the non-ASCII code
    // points as their 2- and 3-byte forms.
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xffff) i++;
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    }
    return n;
  }

  function emptyLog() {
    return {
      lines: [], headTruncated: false, tailDropped: 0, exists: false, size: 0,
      // Where the window begins in the file; 0 = the very first byte. The first
      // read of a window fills it in.
      start: null, loaded: false, expanded: false,
    };
  }

  function readStoredBoard() {
    try {
      return window.localStorage.getItem(BOARD_KEY) || ALL_BOARDS;
    } catch (e) {
      return ALL_BOARDS;
    }
  }

  function storeBoard(value) {
    try {
      window.localStorage.setItem(BOARD_KEY, value || ALL_BOARDS);
    } catch (e) {
      /* private mode / disabled storage — the filter just won't persist */
    }
  }

  function boardSlug(t) {
    return t.board || "default";
  }

  // Display order, mirroring the backend's _sort_key, so a task inserted
  // optimistically after create lands where the next poll would put it
  // instead of jumping to the bottom of the list.
  var STATUS_ORDER = {
    running: 0, scheduled: 1, ready: 2, blocked: 3,
    review: 4, triage: 5, todo: 6, done: 7, archived: 8,
  };

  function compareTasks(a, b) {
    var ka = [
      STATUS_ORDER[a.status] == null ? 99 : STATUS_ORDER[a.status],
      -(a.last_heartbeat_at || 0), -(a.started_at || 0), -(a.created_at || 0),
      a.board || "", a.id || "",
    ];
    var kb = [
      STATUS_ORDER[b.status] == null ? 99 : STATUS_ORDER[b.status],
      -(b.last_heartbeat_at || 0), -(b.started_at || 0), -(b.created_at || 0),
      b.board || "", b.id || "",
    ];
    for (var i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  }

  function Page() {
    var tasksState = useState([]);
    var tasks = tasksState[0];
    var setTasks = tasksState[1];
    var tasksRef = useRef([]);
    tasksRef.current = tasks;

    var tasksErrorState = useState("");
    var tasksError = tasksErrorState[0];
    var setTasksError = tasksErrorState[1];

    var selectedState = useState(null);
    var selected = selectedState[0];
    var setSelected = selectedState[1];
    var selectedRef = useRef(null);
    selectedRef.current = selected;

    var logState = useState(emptyLog());
    var log = logState[0];
    var setLog = logState[1];
    // Source of truth for the active task's log (state mirrors it for render).
    var logRef = useRef(emptyLog());

    var busyState = useState(false);
    var logBusy = busyState[0];
    var setLogBusy = busyState[1];

    // Comment thread for the selected task (mirrors the built-in Kanban plugin).
    var commentsState = useState([]);
    var comments = commentsState[0];
    var setComments = commentsState[1];
    // A comment POST is in flight (disables the send button).
    var commentBusyState = useState(false);
    var commentBusy = commentBusyState[0];
    var setCommentBusy = commentBusyState[1];
    // Inline error / success line under the composer.
    var commentNoteState = useState({ kind: "", text: "" });
    var commentNote = commentNoteState[0];
    var setCommentNote = commentNoteState[1];
    // Composer draft (controlled textarea).
    var draftState = useState("");
    var draft = draftState[0];
    var setDraft = draftState[1];

    // --- Task description (third tab) -------------------------------------
    // Read/written through the bundled plugin's task routes: GET /tasks/{id}
    // carries the full body, PATCH /tasks/{id} with {body} saves it — both
    // already live, so no route is added here.
    var descState = useState(null);
    var desc = descState[0];
    var setDesc = descState[1];
    // Editor mode + its own draft, so polling never clobbers what is typed.
    var descEditState = useState(false);
    var descEdit = descEditState[0];
    var setDescEdit = descEditState[1];
    var descDraftState = useState("");
    var descDraft = descDraftState[0];
    var setDescDraft = descDraftState[1];
    var descBusyState = useState(false);
    var descBusy = descBusyState[0];
    var setDescBusy = descBusyState[1];
    var descNoteState = useState({ kind: "", text: "" });
    var descNote = descNoteState[0];
    var setDescNote = descNoteState[1];

    var showArchivedState = useState(false);
    var showArchived = showArchivedState[0];
    var setShowArchived = showArchivedState[1];

    // Board filter for the left list. ALL_BOARDS ("") = every board.
    var boardState = useState(readStoredBoard());
    var board = boardState[0];
    var setBoard = boardState[1];
    var boardRef = useRef(board);
    boardRef.current = board;

    var boardsState = useState([]);
    var boards = boardsState[0];
    var setBoards = boardsState[1];

    // --- Search over title + description ----------------------------------
    // Filters the left list as the user types (no debounce, no Enter).
    var queryState = useState("");
    var query = queryState[0];
    var setQuery = queryState[1];
    // taskId -> lowercased `body`, used for description matches. The bundled
    // `/board` route is the only one that returns the FULL body, so it is read
    // from there — lazily, the first time a query is typed, and cached after
    // that. Title matches need no fetch at all, so typing never waits on it.
    var searchRef = useRef({ bodies: new Map(), loading: false, refreshing: false });
    // Bumped when the description index lands so the render re-runs.
    var searchTickState = useState(0);
    var searchTick = searchTickState[0];
    var setSearchTick = searchTickState[1];

    // The board the bundled route reports as current (`GET /boards` → `current`).
    // The create form offers it as a hint, but never selects it implicitly.
    var currentBoardState = useState("");
    var currentBoard = currentBoardState[0];
    var setCurrentBoard = currentBoardState[1];

    // Installed Hermes profiles — the create form's assignee picker.
    var profilesState = useState([]);
    var profiles = profilesState[0];
    var setProfiles = profilesState[1];

    // --- New-task form -------------------------------------------------
    var createOpenState = useState(false);
    var createOpen = createOpenState[0];
    var setCreateOpen = createOpenState[1];
    var draftTitleState = useState("");
    var draftTitle = draftTitleState[0];
    var setDraftTitle = draftTitleState[1];
    var draftBodyState = useState("");
    var draftBody = draftBodyState[0];
    var setDraftBody = draftBodyState[1];
    var draftAssigneeState = useState("");
    var draftAssignee = draftAssigneeState[0];
    var setDraftAssignee = draftAssigneeState[1];
    var draftPriorityState = useState("0");
    var draftPriority = draftPriorityState[0];
    var setDraftPriority = draftPriorityState[1];
    // The board is deliberately EMPTY on open: the create form requires an
    // explicit board (ТЗ), so no task can land on an unintended board because a
    // filter happened to be set. `boardHint` only shows what the picker's
    // likely target would be.
    var draftBoardState = useState("");
    var draftBoard = draftBoardState[0];
    var setDraftBoard = draftBoardState[1];
    // Per-task runtime cap in seconds; 0 = бесконечно (no cap). The bundled
    // POST /tasks takes max_runtime_seconds and the dispatcher SIGTERMs the
    // worker once it elapses.
    var draftRuntimeState = useState("0");
    var draftRuntime = draftRuntimeState[0];
    var setDraftRuntime = draftRuntimeState[1];
    // Initial status: `ready` (default), `todo`, `triage` or `blocked`. The core
    // create route only parks a task in triage/blocked; `todo` is reached by a
    // follow-up PATCH, exactly as a drag to Todo does in the built-in plugin.
    var draftStatusState = useState("ready");
    var draftStatus = draftStatusState[0];
    var setDraftStatus = draftStatusState[1];
    var draftWsKindState = useState("scratch");
    var draftWsKind = draftWsKindState[0];
    var setDraftWsKind = draftWsKindState[1];
    var draftWsPathState = useState("");
    var draftWsPath = draftWsPathState[0];
    var setDraftWsPath = draftWsPathState[1];
    var createBusyState = useState(false);
    var createBusy = createBusyState[0];
    var setCreateBusy = createBusyState[1];
    var createNoteState = useState({ kind: "", text: "" });
    var createNote = createNoteState[0];
    var setCreateNote = createNoteState[1];

    // "развернуть лог": load the file from byte 0 instead of only its tail.
    // Per task (taskId -> bool) and mirrored into `expanded` for rendering.
    var expandState = useState({});
    var expanded = expandState[0];
    var setExpanded = expandState[1];
    // Bumped by toggleExpand to re-run the log-polling effect with the new
    // expanded flag. Declared here (with the other state) because the log
    // effect below lists it in its deps — a `var` assigned further down would
    // still be undefined when that deps array is evaluated.
    var expandTickState = useState(0);
    var expandTick = expandTickState[0];
    var setExpandTick = expandTickState[1];

    var atBottomState = useState(true);
    var atBottom = atBottomState[0];
    var setAtBottom = atBottomState[1];

    // Which pane the right side shows: "log" (live tail) or "comments" (thread).
    var paneState = useState("log");
    var pane = paneState[0];
    var setPane = paneState[1];

    // The DOM element that scrolls.
    var scrollRef = useRef(null);
    // The left task list: its scrolling element plus a taskId -> row lookup so
    // autoscroll can ask "is the selected row still on screen?".
    var listRef = useRef(null);
    var rowRefs = useRef(new Map());
    // Auto-scroll arm for the list: re-armed on every selection / board switch,
    // dropped as soon as the user scrolls the list themselves.
    var listFollowRef = useRef(true);
    // scrollTop we set ourselves. A scroll event that lands on it is our own
    // jump — including the clamp the browser fires when a re-render shrinks
    // the list — and must not read as "the user took over".
    var selfScrollTopRef = useRef(0);
    // The comments thread scroll container (auto-follow the newest comment).
    var commentsScrollRef = useRef(null);
    // scrollTop this plugin last set on the LOG pane. A scroll event landing on
    // it is ours — including the browser's clamp-to-0 when the pane's content
    // is swapped for a shorter window — and must not be read as "the user took
    // over" (which would unpin an expanded window from its top anchor).
    var selfLogScrollRef = useRef(0);
    // Whether a log fetch for the active task is in flight.
    var busyRef = useRef(false);

    // Per-task memory so switching back "continues from where you left off".
    // cache:  taskId -> {lines, headTruncated, exists, size, offset, loaded}
    // mode:   taskId -> "bottom" (auto-follow) | "fixed" (reading a spot)
    // top:    taskId -> scrollTop px (meaningful only when mode === "fixed")
    var cacheRef = useRef(new Map());
    var modeRef = useRef(new Map());
    var topRef = useRef(new Map());
    // Pending one-shot scroll restoration {id, mode, top} applied after the
    // restored content has actually painted.
    var restoreRef = useRef(null);
    // Per-task "развернуть лог" flag; `expanded` state mirrors it for render.
    // Read through a ref so flipping it can restart the log poller without
    // re-running (and re-selecting) anything else.
    var expandRef = useRef({});
    expandRef.current = expanded;

    var api = useCallback(
      function (path, opts) {
        return fetchJSON(API + path, opts).catch(function (e) {
          return { __error: String((e && e.message) || e) };
        });
      },
      []
    );

    // Board a task belongs to (log files live per board).
    var boardOf = useCallback(function (taskId) {
      var list = tasksRef.current;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === taskId) return list[i].board || "default";
      }
      return "default";
    }, []);

    // All tasks across every board, polled.
    useEffect(function () {
      var stop = false;
      function tick() {
        api("/tasks/all").then(function (r) {
          if (stop) return;
          if (r.__error) {
            setTasksError(r.__error);
            return;
          }
          setTasksError("");
          setTasks(r.tasks || []);
          if (!selectedRef.current && r.tasks && r.tasks.length) {
            // first selection: the most recently active, non-archived task
            // (restricted to the chosen board, when one is chosen)
            var filter = boardRef.current;
            var pick = r.tasks.filter(function (t) {
              if (t.status === "archived") return false;
              return filter === ALL_BOARDS || boardSlug(t) === filter;
            })[0];
            if (pick) setSelected(pick.id);
          }
        });
      }
      tick();
      var h = setInterval(tick, TASK_POLL_MS);
      return function () {
        stop = true;
        clearInterval(h);
      };
    }, [api]);

    // Board list for the selector. Boards come and go rarely — poll slowly.
    // Each entry keeps board.json's `default_workdir` (the project directory) and
    // `default_workspace_kind`, which the bundled route derives by probing the
    // workdir for a git toplevel: worktree for a repo, dir otherwise. The create
    // form copies both straight into its workspace row, so the form offers a
    // git worktree for a repo-backed board without re-probing anything here.
    useEffect(function () {
      var stop = false;
      function tick() {
        fetchJSON(KANBAN_API + "/boards").then(function (r) {
          if (stop || r.__error || !r.boards) return;
          setBoards(
            r.boards.map(function (b) {
              return {
                slug: b.slug,
                name: b.name || b.slug,
                default_workdir: b.default_workdir || "",
                default_workspace_kind: b.default_workspace_kind || "scratch",
                project_name: b.project_name || "",
              };
            })
          );
          setCurrentBoard(r.current || "");
        }).catch(function () {});
      }
      tick();
      var h = setInterval(tick, BOARDS_POLL_MS);
      return function () {
        stop = true;
        clearInterval(h);
      };
    }, []);

    // Description index for search, built lazily on the first non-empty query.
    //
    // `/tasks/all` (this plugin's route) carries title but not the body, so
    // description matches need the bundled `/board` route, which returns the
    // full body per card. That route is per-board, so one request per board is
    // fired once and cached in `searchRef` — typing never re-fetches. A stale
    // body (edited on the description tab, or a task created since) is picked up
    // by the periodic refresh below.
    useEffect(function () {
      var q = (query || "").trim();
      if (!q) return;
      var index = searchRef.current;
      if (index.loading || index.refreshing) return;
      // A board may not have been listed yet on the very first keystroke; wait
      // for the boards poll rather than indexing nothing.
      if (!boards.length) return;
      index.loading = true;
      Promise.all(
        boards.map(function (b) {
          return fetchJSON(
            KANBAN_API + "/board?include_archived=true&board=" + encodeURIComponent(b.slug)
          ).then(function (r) {
            var out = [];
            if (!r || r.__error || !r.columns) return out;
            for (var i = 0; i < r.columns.length; i++) {
              var ts = r.columns[i].tasks || [];
              for (var j = 0; j < ts.length; j++) {
                if (ts[j].id) out.push([ts[j].id, (ts[j].body || "").toLowerCase()]);
              }
            }
            return out;
          }).catch(function () { return []; });
        })
      ).then(function (perBoard) {
        var bodies = new Map();
        for (var i = 0; i < perBoard.length; i++) {
          for (var j = 0; j < perBoard[i].length; j++) {
            bodies.set(perBoard[i][j][0], perBoard[i][j][1]);
          }
        }
        index.bodies = bodies;
        index.loading = false;
        setSearchTick(function (n) { return n + 1; });
      });
    }, [query, boards]);

    // Keep the index honest while a query is active: a card whose body was
    // edited (or created) after the index was built would otherwise never match
    // on description. 15 s mirrors the boards poll — search stays responsive and
    // this costs one request per board only while the user is typing.
    useEffect(function () {
      if (!(query || "").trim()) return;
      var index = searchRef.current;
      var h = setInterval(function () {
        if (index.loading || index.refreshing) return;
        index.refreshing = true;
        fetchJSON(KANBAN_API + "/board?include_archived=true&board=" +
          encodeURIComponent(board === ALL_BOARDS ? (currentBoard || "default") : board))
          .then(function (r) {
            index.refreshing = false;
            if (!r || r.__error || !r.columns) return;
            for (var i = 0; i < r.columns.length; i++) {
              var ts = r.columns[i].tasks || [];
              for (var j = 0; j < ts.length; j++) {
                if (ts[j].id) index.bodies.set(ts[j].id, (ts[j].body || "").toLowerCase());
              }
            }
            setSearchTick(function (n) { return n + 1; });
          }).catch(function () { index.refreshing = false; });
      }, 15000);
      return function () { clearInterval(h); };
    }, [query, board, currentBoard]);

    function matchesQuery(t) {
      var q = (query || "").trim().toLowerCase();
      if (!q) return true;
      if ((t.title || "").toLowerCase().indexOf(q) !== -1) return true;
      var body = searchRef.current.bodies.get(t.id);
      return !!(body && body.indexOf(q) !== -1);
    }

    // Installed profiles for the create form's assignee picker.
    useEffect(function () {
      var stop = false;
      function tick() {
        fetchJSON(KANBAN_API + "/profiles").then(function (r) {
          if (stop || r.__error || !r.profiles) return;
          setProfiles(r.profiles);
        }).catch(function () {});
      }
      tick();
      var h = setInterval(tick, PROFILES_POLL_MS);
      return function () {
        stop = true;
        clearInterval(h);
      };
    }, []);

    // A board that vanished (deleted/renamed) must not stay selected, or the
    // list would sit empty with no way back except the reload.
    useEffect(function () {
      if (!board || !boards.length) return;
      if (boards.some(function (b) { return b.slug === board; })) return;
      setBoard(ALL_BOARDS);
      storeBoard(ALL_BOARDS);
    }, [boards, board]);

    // Switching boards must not leave the right pane on a task that the left
    // panel no longer lists — take that board's first visible task instead.
    // (Reading the selection through a ref keeps this out of the deps: the
    // effect must not re-run — and re-pick — on every manual selection.)
    useEffect(function () {
      if (board === ALL_BOARDS || !tasks.length) return;
      var cur = selectedRef.current;
      // Keep the current selection only if it is still listed and on this board.
      if (
        cur &&
        boardOf(cur) === board &&
        tasks.some(function (t) {
          return t.id === cur;
        })
      ) {
        return;
      }
      var pool = tasks.filter(function (t) {
        return boardSlug(t) === board &&
          (showArchived || t.status !== "archived");
      });
      setSelected(pool.length ? pool[0].id : null);
    }, [board, tasks, showArchived, boardOf]);

    // --- Autoscroll ------------------------------------------------------
    // Move the list just enough to bring the selected row back on screen.
    // Never uses scrollIntoView: that would also scroll the page around it.
    function ensureRowVisible() {
      var list = listRef.current;
      var id = selectedRef.current;
      if (!list || !id) return;
      var row = rowRefs.current.get(id);
      if (!row) return;
      var lb = list.getBoundingClientRect();
      var rb = row.getBoundingClientRect();
      if (rb.top >= lb.top && rb.bottom <= lb.bottom) return;
      list.scrollTop += rb.top < lb.top
        ? rb.top - lb.top
        : rb.bottom - lb.bottom;
      // Read back: the browser clamps, and the event we are about to cause
      // reports the clamped value.
      selfScrollTopRef.current = list.scrollTop;
    }

    // A manual scroll of the list wins until the next selection / board switch.
    function onListScroll(e) {
      var node = e.currentTarget || e.target;
      if (Math.abs(node.scrollTop - selfScrollTopRef.current) < 2) return;
      listFollowRef.current = false;
    }

    // Selecting a task (or switching boards) puts its row back on screen.
    useEffect(function () {
      listFollowRef.current = true;
      if (listRef.current) selfScrollTopRef.current = listRef.current.scrollTop;
      ensureRowVisible();
    }, [selected, board]);

    // Programmatic scroll of the log pane. Recording the value we set is what
    // lets onScroll tell our own jump (or the browser's clamp after it) apart
    // from a real user scroll.
    function scrollLogTo(el, top) {
      if (!el) return;
      el.scrollTop = top;
      // Read back: the browser clamps, and the event we are about to cause
      // reports the clamped value.
      selfLogScrollRef.current = el.scrollTop;
    }

    // 0.5s watchdog. Two things move content out from under the user between
    // renders: the task list re-sorts when a task changes status (it jumps
    // between the running/queued/archived groups), and the log grows between
    // its 1.2s polls. Both are cheap no-ops when nothing needs moving.
    useEffect(function () {
      var h = setInterval(function () {
        if (listFollowRef.current) ensureRowVisible();
        var id = selectedRef.current;
        var logPane = scrollRef.current;
        if (!logPane || !id) return;
        // Only "bottom" follows the tail. "fixed" = the user is reading a spot,
        // "top" = the expanded window, anchored at the file's first line.
        if (modeRef.current.get(id) !== "bottom") return;
        var gap = logPane.scrollHeight - logPane.scrollTop - logPane.clientHeight;
        if (gap > 1 && logPane.scrollHeight > logPane.clientHeight) {
          scrollLogTo(logPane, logPane.scrollHeight);
        }
      }, FOLLOW_MS);
      return function () {
        clearInterval(h);
      };
    }, []);

    // Coming back from the comments tab remounts the log pane, which starts
    // at scrollTop 0 — re-pin it if it was following the bottom (and re-anchor
    // at the top for an expanded window).
    useEffect(function () {
      if (pane !== "log") return;
      var id = selectedRef.current;
      if (!id) return;
      var el = scrollRef.current;
      if (!el) return;
      var mode = modeRef.current.get(id);
      if (mode === "bottom") {
        scrollLogTo(el, el.scrollHeight);
        setAtBottom(true);
      } else if (mode === "top") {
        scrollLogTo(el, 0);
        setAtBottom(false);
      }
    }, [pane]);

    // On (re)selection: load the cached log (if any) and queue scroll restore.
    useEffect(function () {
      if (!selected) {
        logRef.current = emptyLog();
        setLog(emptyLog());
        restoreRef.current = null;
        return;
      }
      var cached = cacheRef.current.get(selected);
      var next = cached
        ? {
            lines: cached.lines,
            headTruncated: cached.headTruncated,
            tailDropped: cached.tailDropped,
            exists: cached.exists,
            size: cached.size,
            start: cached.start,
            loaded: cached.loaded,
            expanded: cached.expanded,
          }
        : emptyLog();
      logRef.current = next;
      setLog(next);
      var mode = modeRef.current.get(selected) || "bottom";
      setAtBottom(mode === "bottom");
      restoreRef.current = {
        id: selected,
        mode: mode,
        top: topRef.current.get(selected) || 0,
      };
    }, [selected]);

    // Apply the queued scroll restore once the restored content has painted.
    useEffect(function () {
      var want = restoreRef.current;
      if (!want || want.id !== selected) return;
      // While the rendered `log` still lags the logical logRef.current the
      // new task's content hasn't painted yet — measuring scrollHeight now
      // would be against the previous task's DOM. Wait one more paint.
      if (log !== logRef.current) return;
      var el = scrollRef.current;
      if (!el) return;
      // A not-yet-loaded (empty) log keeps "bottom" as its resting spot; the
      // first chunk's auto-pin (or this effect re-running once it loads) takes
      // care of it. No need to place the scrollbar on an empty pane.
      if (log.lines.length === 0 && !log.loaded) return;
      restoreRef.current = null;
      if (want.mode === "bottom") {
        scrollLogTo(el, el.scrollHeight);
      } else if (want.mode === "top") {
        scrollLogTo(el, 0);
      } else {
        scrollLogTo(el, want.top);
      }
    }, [selected, log]);

    // Log window for the selected task, polled.
    //
    // The bundled route answers with the whole window on every call (`tail`
    // for the tail view, the entire file once expanded), so there is no offset
    // to carry between polls and nothing to merge: both windows are suffixes of
    // one growing file, which means each response already contains everything
    // the previous one did. That also makes rotation a non-event — the window
    // simply describes the file that is there now.
    useEffect(function () {
      if (!selected) return;
      var stop = false;
      var expanded = !!expandRef.current[selected];

      function tick() {
        if (busyRef.current) return;
        var taskId = selectedRef.current;
        if (!taskId) return;
        busyRef.current = true;
        setLogBusy(true);
        fetchJSON(
          KANBAN_API + "/tasks/" + encodeURIComponent(taskId) + "/log?board=" +
          encodeURIComponent(boardOf(taskId)) +
          (expanded ? "" : "&tail=" + TAIL_BYTES)
        ).then(function (r) {
          // Always release the busy flag first (even for a stale response),
          // otherwise switching tasks mid-fetch would wedge polling forever.
          busyRef.current = false;
          setLogBusy(false);
          if (stop || selectedRef.current !== taskId) return;
          var detail = r && (r.detail || r.error);
          if (detail) {
            setTasksError(String(detail));
            return;
          }
          var content = r.content || "";
          var lines = content ? content.split("\n") : [];
          // A trailing newline leaves a final empty element that is not a line.
          if (lines.length && lines[lines.length - 1] === "") lines.pop();

          var size = r.size_bytes || 0;
          // `truncated` is the route's own "the file is bigger than the window
          // you asked for" flag, so the window begins at byte 0 exactly when it
          // is false. Do NOT derive that by subtracting the returned length
          // from the file size: the route reads in text mode, so universal
          // newlines rewrite each CRLF as LF and a COMPLETE read comes back
          // ~1 byte per line pair short of `size_bytes`. Subtraction would then
          // invent a non-zero start for a window that began at byte 0.
          var windowStart = r.truncated ? Math.max(0, size - byteLen(content)) : 0;

          // An expanded window starts at byte 0, so it keeps the FIRST lines and
          // only the tail view trims from the end.
          var cap = expanded ? MAX_LINES_FULL : MAX_LINES;
          var tailDropped = 0;
          if (lines.length > cap) {
            tailDropped = lines.length - cap;
            lines = expanded ? lines.slice(0, cap) : lines.slice(tailDropped);
          }

          var next = {
            lines: lines,
            headTruncated: windowStart > 0,
            tailDropped: tailDropped,
            exists: !!r.exists,
            size: size,
            start: windowStart,
            loaded: true,
            expanded: expanded,
          };
          logRef.current = next;
          cacheRef.current.set(taskId, next);
          setLog(next);
          // Following the bottom? Keep pinned. ("fixed" = the user is reading a
          // specific spot; "top" = the expanded window, anchored at byte 0.)
          if (modeRef.current.get(taskId) === "bottom") {
            var el = scrollRef.current;
            if (el && content) scrollLogTo(el, el.scrollHeight);
          }
        }).catch(function (e) {
          busyRef.current = false;
          setLogBusy(false);
          if (stop || selectedRef.current !== taskId) return;
          setTasksError(String((e && e.message) || e));
        });
      }
      tick();
      var h = setInterval(tick, LOG_POLL_MS);
      return function () {
        stop = true;
        clearInterval(h);
      };
    }, [selected, boardOf, expandTick]);

    // Comment thread for the selected task, polled (workers post comments live,
    // so this mirrors the task-log tail but on a slower cadence).
    var COMMENT_POLL_MS = 5000;
    useEffect(function () {
      if (!selected) {
        setComments([]);
        setCommentNote({ kind: "", text: "" });
        return;
      }
      var stop = false;
      function load() {
        api("/tasks/" + encodeURIComponent(selected) + "/comments?board=" +
          encodeURIComponent(boardOf(selected))).then(function (r) {
          if (stop || selectedRef.current !== selected) return;
          if (r.__error) return; // transient — keep the last good list
          setComments(r.comments || []);
        });
      }
      load();
      var h = setInterval(load, COMMENT_POLL_MS);
      return function () {
        stop = true;
        clearInterval(h);
      };
    }, [selected, api, boardOf]);

    // Auto-scroll the comments pane to the newest comment when it changes or
    // when the user switches to the comments pane.
    useEffect(function () {
      if (pane !== "comments") return;
      var el = commentsScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [pane, comments.length]);

    // Description of the selected task, polled while the description tab is
    // open. The route is the bundled one (GET /tasks/{id}?board=), which returns
    // the FULL body — the list route only carries a 200-char preview.
    var DESC_POLL_MS = 5000;
    useEffect(function () {
      if (!selected || pane !== "description") {
        setDesc(null);
        setDescEdit(false);
        return;
      }
      var stop = false;
      function load() {
        fetchJSON(
          KANBAN_API + "/tasks/" + encodeURIComponent(selected) + "?board=" +
          encodeURIComponent(boardOf(selected))
        ).then(function (r) {
          if (stop || selectedRef.current !== selected) return;
          if (r.__error || !r.task) return;
          setDesc({
            id: r.task.id,
            title: r.task.title || "",
            body: r.task.body || "",
            status: r.task.status,
            assignee: r.task.assignee || "",
            workspace: (r.task.workspace_kind || "scratch") +
              (r.task.workspace_path ? " · " + r.task.workspace_path : ""),
            runtime: r.task.max_runtime_seconds || 0,
          });
          // Never overwrite an open editor with a poll result.
          if (!descEdit) setDescDraft(r.task.body || "");
        }).catch(function () {});
      }
      load();
      var h = setInterval(load, DESC_POLL_MS);
      return function () {
        stop = true;
        clearInterval(h);
      };
      // descEdit is read through the state captured per run; re-running on it
      // would restart the poller on every keystroke, so it is intentionally
      // absent and the guard above simply uses the value from mount time.
    }, [selected, pane, boardOf]);

    function startDescEdit() {
      if (!desc) return;
      setDescDraft(desc.body || "");
      setDescNote({ kind: "", text: "" });
      setDescEdit(true);
    }

    function cancelDescEdit() {
      setDescEdit(false);
      setDescDraft(desc ? desc.body || "" : "");
      setDescNote({ kind: "", text: "" });
    }

    function saveDesc() {
      var id = selectedRef.current;
      if (!id || descBusy) return;
      setDescBusy(true);
      setDescNote({ kind: "", text: "" });
      fetchJSON(
        KANBAN_API + "/tasks/" + encodeURIComponent(id) + "?board=" +
        encodeURIComponent(boardOf(id)),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: descDraft }),
        }
      ).then(function (r) {
        setDescBusy(false);
        if (r.__error || r.detail || !r.task) {
          setDescNote({
            kind: "err",
            text: r.detail || r.error || r.__error || "не удалось сохранить описание",
          });
          return;
        }
        setDesc(function (prev) {
          if (!prev) return prev;
          var next = {};
          for (var k in prev) {
            if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
          }
          next.body = r.task.body || "";
          return next;
        });
        setDescEdit(false);
        setDescNote({ kind: "ok", text: "описание сохранено" });
        setTimeout(function () {
          setDescNote(function (n) {
            return n.kind === "ok" ? { kind: "", text: "" } : n;
          });
        }, 2500);
      }).catch(function (e) {
        setDescBusy(false);
        setDescNote({ kind: "err", text: String((e && e.message) || e) });
      });
    }

    function onDescKeyDown(e) {
      // Ctrl/Cmd+Enter saves, Esc leaves the editor — same keys as the comment
      // composer, so the two panes behave alike.
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveDesc();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelDescEdit();
      }
    }

    // Append a comment (the one write the plugin performs). Called from the
    // send button and from onDraftKeyDown (Ctrl/Cmd+Enter). The draft lives in
    // `draft` state, not in the event, so a stale/absent event is harmless.
    function submitComment() {
      var id = selectedRef.current;
      if (!id || commentBusy) return;
      var text = draft.trim();
      if (!text) {
        setCommentNote({ kind: "err", text: "пустой комментарий" });
        return;
      }
      setCommentBusy(true);
      setCommentNote({ kind: "", text: "" });
      setDraft("");
      api("/tasks/" + encodeURIComponent(id) + "/comments?board=" +
        encodeURIComponent(boardOf(id)), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: text }),
        }).then(function (r) {
          setCommentBusy(false);
          if (r.__error) {
            // restore the draft on failure so nothing is lost
            setDraft(text);
            setCommentNote({ kind: "err", text: r.__error });
            return;
          }
          setCommentNote({ kind: "ok", text: "комментарий добавлен" });
          // Optimistic append so the thread updates without waiting a poll tick.
          // Dedupe by id: a poll can commit the server copy first (or the POST
          // resolves after one already did), which would otherwise render two
          // rows for the same comment id.
          setComments(function (prev) {
            var postedId = r.id || 0;
            if (prev.some(function (c) { return c.id === postedId; })) return prev;
            return prev.concat([{
              id: (r.id || 0),
              author: "dashboard",
              body: text,
              created_at: Math.floor(Date.now() / 1000),
            }]);
          });
          // Clear the success note after a beat.
          setTimeout(function () {
            setCommentNote(function (n) {
              return n.kind === "ok" ? { kind: "", text: "" } : n;
            });
          }, 2500);
        });
    }

    function onDraftKeyDown(e) {
      // Ctrl/Cmd+Enter sends from the textarea; plain Enter inserts a newline.
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitComment();
      }
    }

    function onScroll(e) {
      var el = e.target;
      var id = selectedRef.current;
      if (!id) return;
      // Our own jump (and the clamp that follows it) is not the user taking over.
      if (Math.abs(el.scrollTop - selfLogScrollRef.current) < 2) return;
      var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
      setAtBottom(atBottom);
      // Three resting spots: the tail (follow), the file's first line ("top"),
      // and a spot the user picked.
      if (atBottom) {
        modeRef.current.set(id, "bottom");
      } else if (el.scrollTop < BOTTOM_THRESHOLD) {
        modeRef.current.set(id, "top");
        topRef.current.set(id, 0);
      } else {
        modeRef.current.set(id, "fixed");
        topRef.current.set(id, el.scrollTop);
      }
    }

    function jumpToBottom() {
      var el = scrollRef.current;
      var id = selectedRef.current;
      if (id) modeRef.current.set(id, "bottom");
      scrollLogTo(el, el ? el.scrollHeight : 0);
      setAtBottom(true);
    }

    // "развернуть лог" / "свернуть": drop the cached window for this task and
    // restart the poll from byte 0 (expanded) or from the tail. Bumping
    // `expandTick` re-runs the log effect, which re-reads the flag from
    // expandRef — no other effect (and no re-selection) is disturbed.
    function toggleExpand() {
      var id = selectedRef.current;
      if (!id) return;
      var next = {};
      for (var k in expandRef.current) {
        if (Object.prototype.hasOwnProperty.call(expandRef.current, k)) {
          next[k] = expandRef.current[k];
        }
      }
      next[id] = !next[id];
      setExpanded(next);
      // The cached window was read with the other mode — drop it so the
      // re-run refetches instead of showing the previous mode's bytes.
      cacheRef.current.delete(id);
      var fresh = emptyLog();
      fresh.expanded = !!next[id];
      logRef.current = fresh;
      setLog(fresh);
      // Expanding shows the file's beginning: land there, not at the bottom.
      modeRef.current.set(id, next[id] ? "top" : "bottom");
      topRef.current.set(id, 0);
      setAtBottom(!next[id]);
      // Swapping the content for an empty one makes the browser clamp scrollTop
      // to 0 and fire a scroll event. Record 0 as "ours" so onScroll leaves the
      // mode alone and the expanded window stays anchored at its first line.
      if (next[id]) selfLogScrollRef.current = 0;
      restoreRef.current = null;
      setExpandTick(function (n) { return n + 1; });
    }

    // --- New task -------------------------------------------------------
    // The board a fresh form would land on if the user just hit Enter: the board
    // the header filter points at, else the route's current board. Shown as a
    // hint only — `draftBoard` starts empty so the board must be chosen.
    function boardHint() {
      if (board !== ALL_BOARDS && board) return board;
      if (currentBoard) return currentBoard;
      return boards.length ? boards[0].slug : "";
    }

    // Copy a board's workspace defaults into the form. `default_workspace_kind`
    // is the bundled route's own recommendation: worktree when the board's
    // project directory is a git repo, dir otherwise, scratch without one.
    // Called both on open and whenever the board select changes, so switching
    // boards re-proposes the right workspace instead of keeping the old one.
    function applyBoardWorkspace(slug) {
      var meta = null;
      for (var i = 0; i < boards.length; i++) {
        if (boards[i].slug === slug) meta = boards[i];
      }
      var workdir = meta ? meta.default_workdir : "";
      if (!workdir) {
        setDraftWsKind("scratch");
        setDraftWsPath("");
        return;
      }
      setDraftWsKind(meta.default_workspace_kind === "dir" ? "dir" : "worktree");
      setDraftWsPath(workdir);
    }

    function openCreate() {
      setDraftBoard("");
      applyBoardWorkspace("");
      setDraftTitle("");
      setDraftBody("");
      setDraftAssignee("");
      setDraftPriority("0");
      setDraftRuntime("0");
      setDraftStatus("ready");
      setCreateNote({ kind: "", text: "" });
      setCreateOpen(true);
    }

    function closeCreate() {
      if (createBusy) return;
      setCreateOpen(false);
    }

    function submitCreate() {
      if (createBusy) return;
      var title = draftTitle.trim();
      if (!title) {
        setCreateNote({ kind: "err", text: "нужен заголовок" });
        return;
      }
      // The board is explicit by design (ТЗ) — no implicit fallback to the
      // filter or to `default`, which is how tasks used to land on the wrong one.
      if (!draftBoard) {
        setCreateNote({ kind: "err", text: "выберите доску явно" });
        return;
      }
      if (draftWsKind === "dir" && !draftWsPath.trim()) {
        setCreateNote({ kind: "err", text: "нужен путь к каталогу" });
        return;
      }
      // Runtime cap in seconds; 0 or blank = бесконечно. Reject negatives and
      // junk early rather than sending them to the dispatcher.
      var runtime = parseInt(draftRuntime, 10);
      if (isNaN(runtime) || runtime < 0) {
        setCreateNote({ kind: "err", text: "время должно быть числом секунд (0 = бесконечно)" });
        return;
      }
      setCreateBusy(true);
      setCreateNote({ kind: "", text: "" });
      var payload = {
        title: title,
        body: draftBody,
        assignee: draftAssignee || null,
        priority: parseInt(draftPriority, 10) || 0,
        // 0 means "no cap" — the column stays NULL so the dispatcher's
        // `max_runtime_seconds IS NOT NULL` guard skips the task entirely.
        max_runtime_seconds: runtime > 0 ? runtime : null,
      };
      // `triage` and `blocked` are create-time states in the core; `todo` is
      // reached by the follow-up PATCH below.
      if (draftStatus === "triage") payload.triage = true;
      if (draftWsKind) payload.workspace_kind = draftWsKind;
      // A path only means something for a persistent workspace; sending one
      // with scratch would pin a scratch task to a directory.
      if (draftWsKind !== "scratch" && draftWsPath.trim()) {
        payload.workspace_path = draftWsPath.trim();
      }
      fetchJSON(
        KANBAN_API + "/tasks?board=" + encodeURIComponent(draftBoard),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      ).then(function (r) {
        setCreateBusy(false);
        if (!r.task) {
          setCreateNote({
            kind: "err",
            text: r.detail || r.error || r.__error || "не удалось создать задачу",
          });
          return;
        }
        var created = r.task;
        // `todo` and `blocked` are not create-time states in the core, so the
        // card is created and then moved through the very same PATCH the
        // built-in plugin uses for a drag into that column. `ready` (default) and
        // `triage` (sent as a flag) need no second call.
        var wantsMove = draftStatus === "todo" || draftStatus === "blocked";
        var move = function (target, done) {
          if (!wantsMove || target !== draftStatus) {
            done(null);
            return;
          }
          fetchJSON(
            KANBAN_API + "/tasks/" + encodeURIComponent(created.id) + "?board=" +
            encodeURIComponent(draftBoard),
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(target === "blocked" ? { status: "blocked" } : { status: "todo" }),
            }
          ).then(function (m) {
            done(m && m.task ? m.task : null);
          }).catch(function (e) {
            done({ __error: String((e && e.message) || e) });
          });
        };
        move(draftStatus, function (patched) {
          if (patched && patched.status) created.status = patched.status;
          insertCreated(created);
        });
      }).catch(function (e) {
        setCreateBusy(false);
        setCreateNote({ kind: "err", text: String((e && e.message) || e) });
      });

      // Two things the bundled serializer does not give us:
      //  - `board`, which this panel resolves from the list it holds — without
      //    it boardOf() answers "default" for a task created on another board
      //    and the log/comments polls ask the wrong board (404);
      //  - the row itself, which only the next 2s poll would deliver. It is
      //    inserted here (sorted like the backend does) so the task is visible
      //    and selectable at once, for the same boardOf() reason.
      function insertCreated(created) {
        setCreateBusy(false);
        created.board = draftBoard;
        setTasks(function (prev) {
          if (prev.some(function (t) { return t.id === created.id; })) return prev;
          return prev.concat([created]).sort(compareTasks);
        });
        if (board !== ALL_BOARDS && boardSlug(created) !== board) {
          setBoard(boardSlug(created));
          storeBoard(boardSlug(created));
        }
        setSelected(created.id);
        setPane("log");
        setCreateOpen(false);
        setCreateNote({ kind: "ok", text: "создано: " + created.id });
      }
    }

    function onCreateKeyDown(e) {
      // Enter submits (Shift+Enter keeps the newline), Esc closes.
      if (e.key === "Enter" && !e.shiftKey && e.target &&
          e.target.tagName === "INPUT") {
        e.preventDefault();
        submitCreate();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeCreate();
      }
    }

    function visibleTasks() {
      var filter = board === ALL_BOARDS ? null : board;
      var q = (query || "").trim();
      return tasks.filter(function (t) {
        if (filter && boardSlug(t) !== filter) return false;
        if (!showArchived && t.status === "archived") return false;
        if (q && !matchesQuery(t)) return false;
        return true;
      });
    }

    // Counters describe what the list is showing: with a board chosen they
    // count that board only.
    function counts() {
      var c = { running: 0, other: 0, archived: 0 };
      tasks.forEach(function (t) {
        if (board !== ALL_BOARDS && boardSlug(t) !== board) return;
        if (t.status === "running" || t.status === "scheduled") c.running++;
        else if (t.status === "archived") c.archived++;
        else c.other++;
      });
      return c;
    }

    var c = counts();
    var vt = visibleTasks();

    var el = R.createElement;

    // Board selector — which board's tasks the left list shows. "Все доски"
    // keeps the merged view; the choice is remembered between visits.
    var boardSelect = el(
      "select",
      {
        className: "hlv-select",
        value: board,
        title: "доска задач",
        "aria-label": "доска задач",
        onChange: function (e) {
          var next = e.target.value || ALL_BOARDS;
          setBoard(next);
          storeBoard(next);
        },
      },
      el("option", { value: ALL_BOARDS }, "Все доски"),
      boards.map(function (b) {
        return el(
          "option",
          { key: b.slug, value: b.slug },
          b.name === b.slug ? b.slug : b.slug + " — " + b.name
        );
      })
    );

    // The board select and the "archived" checkbox share one stacked block: the
    // checkbox sits directly under the board combobox (ТЗ) instead of drifting
    // to the far right of the toolbar next to the new-task button.
    var boardBlock = el(
      "div",
      { className: "hlv-board-block" },
      boardSelect,
      el(
        "label",
        { className: "hlv-check" },
        el("input", {
          type: "checkbox",
          checked: showArchived,
          onChange: function (e) { setShowArchived(e.target.checked); },
        }),
        " archived"
      )
    );

    var header = el(
      "div",
      { className: "hlv-header" },
      boardBlock,
      el("span", { className: "hlv-hints" },
        c.running + " running · " + c.other + " queued · " + c.archived + " archived"),
      el("div", { className: "hlv-header-actions" },
        createNote.text && !createOpen ? el("span", {
          className: "hlv-hints hlv-create-flash " + createNote.kind,
          title: "последний результат создания задачи",
        }, createNote.text) : null,
        el("button", {
          type: "button",
          className: "hlv-btn",
          title: "создать задачу (Enter — создать, Esc — закрыть)",
          onClick: openCreate,
        }, "+ Новая задача"),
        el("span", {
          className: "hlv-dot" + (logBusy ? " hlv-dot-busy" : ""),
          title: logBusy ? "загрузка лога…" : "idle"
        })
      )
    );

    // Search field, directly above the task list (left column). Filters on every
    // keystroke — no debounce, no Enter. Matches the title and the description;
    // the clear button only appears once there is something to clear.
    var searchBox = el(
      "div",
      { className: "hlv-search" },
      el("input", {
        className: "hlv-input hlv-search-input",
        type: "search",
        value: query,
        placeholder: "поиск по названию и описанию…",
        "aria-label": "поиск задач по названию и описанию",
        onChange: function (e) { setQuery(e.target.value); },
      }),
      query
        ? el("button", {
            type: "button",
            className: "hlv-search-clear",
            title: "очистить поиск",
            onClick: function () { setQuery(""); },
          }, "×")
        : null
    );

    var list = el(
      "div",
      { className: "hlv-list", ref: listRef, onScroll: onListScroll },
      vt.length === 0
        ? el("div", { className: "hlv-empty" },
            tasksError
              ? "error: " + tasksError
              : (query || "").trim()
                // A search that matched nothing is a different message from an
                // empty board — say which, so the user knows to clear the filter.
                ? "по запросу «" + query.trim() + "» ничего не найдено"
                : board === ALL_BOARDS
                  ? "no tasks"
                  : "на доске «" + board + "» задач нет")
        : vt.map(function (t) {
            var active = t.id === selected;
            return el(
              "button",
              {
                key: t.id,
                type: "button",
                "data-task-id": t.id,
                className: "hlv-row" + (active ? " active" : ""),
                ref: function (node) {
                  if (node) rowRefs.current.set(t.id, node);
                  else rowRefs.current.delete(t.id);
                },
                onClick: function () { setSelected(t.id); },
                title: t.id + (t.board ? " · board " + t.board : ""),
              },
              el("span", { className: "hlv-row-title" }, t.title),
              el("span", { className: "hlv-row-meta" },
                el("span", { className: statusClass(t.status) }, STATUS_LABEL[t.status] || t.status),
                t.board ? el("span", { className: "hlv-row-board" }, t.board) : null,
                t.assignee ? el("span", { className: "hlv-row-assignee" }, "@" + t.assignee) : null,
                t.comment_count ? el("span", {
                  className: "hlv-row-comments",
                  title: t.comment_count + " комментар.",
                }, "✉ " + t.comment_count) : null,
                el("span", { className: "hlv-row-time" }, timeAgo(t.last_heartbeat_at || t.started_at || t.created_at))
              )
            );
          })
    );

    var preloader = el(
      "div",
      { className: "hlv-preloader" },
      el("span", { className: "hlv-spinner" }),
      el("span", null, "загрузка лога…")
    );

    // --- Log size + "развернуть лог" -------------------------------------
    // Sits on the same row as the лог/комментарии tabs, right-aligned: the file's
    // exact size in bytes, how much of it is on screen, and the toggle that loads
    // the whole file from byte 0 instead of only its tail.
    var isExpanded = !!expanded[selected];
    var logSize = log.size || 0;
    // `start` is where the window begins in the file; 0 = the very first byte.
    var logStart = log.start || 0;
    // How much of the file this window actually covers. Measured from the
    // rendered lines because the line cap can drop the end of a window: the
    // bytes that reached the screen are the file's bytes up to that drop.
    var windowBytes = log.loaded ? byteLen(log.lines.join("\n")) : 0;
    var shownBytes = log.loaded ? Math.min(logSize, logStart + windowBytes) : 0;
    var canExpand = !!selected && log.loaded && log.exists !== false &&
      (isExpanded || logStart > 0);
    var byteTitle = log.loaded && log.exists !== false
      ? "файл: " + logSize + " байт (" + fmtHuman(logSize) + ")" +
        (logStart > 0 ? " · показано с " + logStart + " байт" : " · показано с начала") +
        " · на экране: " + shownBytes + " байт" +
        (log.lines.length ? " · строк: " + log.lines.length : "")
      : "";
    var sizeInfo = selected && log.loaded && log.exists !== false
      ? el("span", { className: "hlv-bytes", title: byteTitle },
          fmtBytes(logSize) +
          (logStart > 0 ? " · " + fmtBytes(shownBytes) : ""))
      : null;
    var expandBtn = canExpand ? el("button", {
      type: "button",
      className: "hlv-expand",
      title: isExpanded
        ? "вернуться к хвосту лога"
        : "показать лог с начала (вместо " + fmtBytes(logSize) + " хвоста)",
      onClick: toggleExpand,
    }, isExpanded ? "свернуть ⤡" : "развернуть ⤢") : null;

    var logContent;
    if (!selected) {
      logContent = el("div", { className: "hlv-empty" }, "выберите задачу слева");
    } else if (!log.loaded) {
      logContent = preloader;
    } else if (log.exists === false) {
      logContent = el("div", { className: "hlv-empty" },
        "файла лога пока нет — он появится, когда воркер запустит задачу");
    } else if (log.lines.length) {
      logContent = el("pre", { className: "hlv-log-pre" }, log.lines.join("\n"));
    } else {
      logContent = el("div", { className: "hlv-empty" }, "лог пока пуст…");
    }

    var logPane = el(
      "div",
      {
        className: "hlv-log",
        ref: scrollRef,
        onScroll: onScroll,
      },
      log.loaded && (log.headTruncated || (isExpanded && log.tailDropped)) &&
        el("div", { className: "hlv-log-head-note" },
          isExpanded
            ? "… показан кусок файла с начала — конец обрезан лимитом в " +
              log.tailDropped + " строк …"
            : "… начало файла отсечено (показан хвост) — «развернуть» покажет его с начала …"),
      logContent,
      selected && log.loaded && log.lines.length && !atBottom && el("button", {
        type: "button",
        className: "hlv-jump",
        onClick: jumpToBottom,
      }, "вниз ↓")
    );

    // --- Comments pane ------------------------------------------------------
    var commentsPane;
    if (!selected) {
      commentsPane = el("div", { className: "hlv-empty" }, "выберите задачу слева");
    } else {
      // The body sits in its own node so long bodies wrap and stay scrollable.
      commentsPane = el(
        "div",
        { className: "hlv-log hlv-comments", ref: commentsScrollRef },
        comments.length === 0
          ? el("div", { className: "hlv-empty" }, "комментариев пока нет")
          : el("div", { className: "hlv-comment-list" },
              comments.map(function (c) {
                return el(
                  "div",
                  { key: c.id, className: "hlv-comment" },
                  el("div", { className: "hlv-comment-head" },
                    el("span", { className: "hlv-comment-author" }, "@" + (c.author || "?")),
                    el("span", { className: "hlv-comment-time" }, timeAgo(c.created_at))),
                  el("div", { className: "hlv-comment-body" }, c.body)
                );
              }))
      );
    }

    // The composer (textarea + send) under the comments pane.
    var composer = el(
      "div",
      { className: "hlv-composer" },
      el("textarea", {
        className: "hlv-composer-input",
        placeholder: "написать комментарий… (Ctrl+Enter — отправить)",
        rows: 2,
        value: draft,
        onChange: function (e) { setDraft(e.target.value); },
        onKeyDown: onDraftKeyDown,
      }),
      el("div", { className: "hlv-composer-row" },
        commentNote.text ? el("span", {
          className: "hlv-composer-note " + commentNote.kind,
        }, commentNote.text) : null,
        el("button", {
          type: "button",
          className: "hlv-composer-send",
          disabled: commentBusy,
          onClick: submitComment,
        }, commentBusy ? "отправка…" : "отправить")
      )
    );

    var commentsView = el(
      "div",
      { className: "hlv-comments-wrap" },
      commentsPane,
      composer
    );

    // --- Description pane --------------------------------------------------
    // The task body, read-only until "редактировать" flips the same node into a
    // textarea; Ctrl/Cmd+Enter saves, Esc cancels.
    var descView;
    if (!selected) {
      descView = el("div", { className: "hlv-empty" }, "выберите задачу слева");
    } else if (!desc) {
      descView = el("div", { className: "hlv-empty" }, "загрузка описания…");
    } else {
      descView = el(
        "div",
        { className: "hlv-log hlv-desc" },
        el("div", { className: "hlv-desc-head" },
          el("span", { className: "hlv-desc-title" }, desc.title || desc.id),
          el("span", { className: "hlv-desc-meta" },
            el("span", { className: statusClass(desc.status) }, STATUS_LABEL[desc.status] || desc.status),
            desc.assignee ? el("span", null, "@" + desc.assignee) : null,
            el("span", null, "воркспейс: " + desc.workspace),
            el("span", {
              title: "лимит времени воркера; 0 = бесконечно",
            }, "время: " + (desc.runtime ? desc.runtime + " с" : "∞"))
          )
        ),
        descEdit
          ? el("textarea", {
              className: "hlv-desc-editor",
              value: descDraft,
              autoFocus: true,
              placeholder: "описание задачи…",
              onChange: function (e) { setDescDraft(e.target.value); },
              onKeyDown: onDescKeyDown,
            })
          : desc.body
            ? el("div", { className: "hlv-desc-body" }, desc.body)
            : el("div", { className: "hlv-empty" }, "описания пока нет")
      );
    }

    var descActions = el(
      "div",
      { className: "hlv-desc-actions" },
      descNote.text ? el("span", { className: "hlv-desc-note " + descNote.kind }, descNote.text) : null,
      descEdit
        ? el("button", {
            type: "button",
            className: "hlv-btn",
            disabled: descBusy,
            onClick: cancelDescEdit,
          }, "отмена")
        : el("button", {
            type: "button",
            className: "hlv-btn",
            disabled: !desc,
            onClick: startDescEdit,
            title: "править описание задачи (Ctrl+Enter — сохранить, Esc — отмена)",
          }, "редактировать"),
      descEdit ? el("button", {
        type: "button",
        className: "hlv-btn hlv-btn-primary",
        disabled: descBusy,
        onClick: saveDesc,
      }, descBusy ? "сохранение…" : "сохранить") : null
    );

    var descriptionView = el(
      "div",
      { className: "hlv-desc-wrap" },
      descView,
      descActions
    );

    // Tab bar above the right pane.
    var rightPane = el(
      "div",
      { className: "hlv-right" },
      el("div", { className: "hlv-tabs" },
        el("button", {
          type: "button",
          className: "hlv-tab" + (pane === "log" ? " active" : ""),
          onClick: function () { setPane("log"); },
        }, "лог"),
        el("button", {
          type: "button",
          className: "hlv-tab" + (pane === "comments" ? " active" : ""),
          onClick: function () { setPane("comments"); },
        }, "комментарии" + (comments.length ? " · " + comments.length : "")),
        el("button", {
          type: "button",
          className: "hlv-tab" + (pane === "description" ? " active" : ""),
          onClick: function () { setPane("description"); },
          title: "описание задачи (тело карточки), с редактированием",
        }, "дескрипшен"),
        el("div", { className: "hlv-tabs-right" },
          sizeInfo,
          expandBtn
        )
      ),
      pane === "log" ? logPane
        : pane === "description" ? descriptionView
        : commentsView
    );

    // The board picker starts on the empty option and must be chosen explicitly
        // (ТЗ). The hint only names where the task would land — it never picks.
        var boardOptions = el(
          "select",
          {
            className: "hlv-select hlv-input",
            value: draftBoard,
            title: "доска, на которой появится задача — выберите явно",
            onChange: function (e) {
              var next = e.target.value;
              setDraftBoard(next);
              // Re-propose the workspace from the newly chosen board: a board
              // with a project directory gets a git worktree (or dir), one
              // without falls back to scratch.
              applyBoardWorkspace(next);
            },
            onKeyDown: onCreateKeyDown,
          },
          el(
            "option",
            { value: "" },
            boardHint() ? "— выберите доску (сейчас: " + boardHint() + ") —" : "— выберите доску —"
          ),
          boards.map(function (b) {
            return el(
              "option",
              { key: b.slug, value: b.slug },
              b.name === b.slug ? b.slug : b.slug + " — " + b.name
            );
          })
        );

        // --- New-task dialog --------------------------------------------------
    var createDialog = !createOpen ? null : el(
      "div",
      {
        className: "hlv-modal-backdrop",
        onClick: function (e) {
          if (e.target === e.currentTarget) closeCreate();
        },
      },
      el("div", { className: "hlv-modal", role: "dialog", "aria-label": "Новая задача" },
        el("div", { className: "hlv-modal-title" }, "Новая задача"),
        el("label", { className: "hlv-field" },
          el("span", { className: "hlv-field-label" }, "Заголовок"),
          el("input", {
            className: "hlv-input",
            value: draftTitle,
            autoFocus: true,
            placeholder: "что нужно сделать…",
            onChange: function (e) { setDraftTitle(e.target.value); },
            onKeyDown: onCreateKeyDown,
          })
        ),
        el("label", { className: "hlv-field" },
          el("span", { className: "hlv-field-label" }, "Описание"),
          el("textarea", {
            className: "hlv-input hlv-textarea",
            rows: 5,
            value: draftBody,
            placeholder: "детали, критерии готовности, ссылки…",
            onChange: function (e) { setDraftBody(e.target.value); },
            onKeyDown: onCreateKeyDown,
          })
        ),
        el("label", { className: "hlv-field" },
          el("span", { className: "hlv-field-label" }, "Профиль"),
          el(
            "select",
            {
              className: "hlv-select hlv-input",
              value: draftAssignee,
              title: "кто выполнит задачу",
              onChange: function (e) { setDraftAssignee(e.target.value); },
              onKeyDown: onCreateKeyDown,
            },
            el("option", { value: "" }, "— не назначен —"),
            profiles.map(function (p) {
              return el(
                "option",
                { key: p.name, value: p.name, title: p.description || "" },
                "@" + p.name + (p.description ? " — " + p.description : "")
              );
            })
          )
        ),
        el("div", { className: "hlv-field-row" },
          el("label", { className: "hlv-field hlv-field-narrow" },
            el("span", { className: "hlv-field-label" }, "Приоритет"),
            el("input", {
              className: "hlv-input",
              type: "number",
              value: draftPriority,
              placeholder: "0",
              title: "выше — раньше dispatcher возьмёт задачу",
              onChange: function (e) { setDraftPriority(e.target.value); },
              onKeyDown: onCreateKeyDown,
            })
          ),
          el("label", { className: "hlv-field hlv-field-narrow" },
            el("span", { className: "hlv-field-label" }, "Время, сек"),
            el("input", {
              className: "hlv-input",
              type: "number",
              min: "0",
              value: draftRuntime,
              placeholder: "0",
              title: "лимит времени воркера; 0 = бесконечно",
              onChange: function (e) { setDraftRuntime(e.target.value); },
              onKeyDown: onCreateKeyDown,
            })
          ),
          el("label", { className: "hlv-field" },
            el("span", { className: "hlv-field-label" }, "Состояние"),
            el(
              "select",
              {
                className: "hlv-select hlv-input",
                value: draftStatus,
                title: "в каком состоянии создать задачу (по умолчанию ready)",
                onChange: function (e) { setDraftStatus(e.target.value); },
                onKeyDown: onCreateKeyDown,
              },
              el("option", { value: "ready" }, "ready — сразу в работу"),
              el("option", { value: "todo" }, "todo — в очередь"),
              el("option", { value: "triage" }, "triage — на уточнение"),
              el("option", { value: "blocked" }, "blocked — ждёт человека")
            )
          )
        ),
        el("label", { className: "hlv-field" },
          el("span", { className: "hlv-field-label" }, "Доска"),
          boardOptions,
          el("span", { className: "hlv-modal-hint" },
            "доску нужно выбрать явно — задача не создастся на «" +
            (boardHint() || "default") + "» молча")
        ),
        el("div", { className: "hlv-field-row" },
          el("label", { className: "hlv-field" },
            el("span", { className: "hlv-field-label" }, "Воркспейс"),
            el(
              "select",
              {
                className: "hlv-select hlv-input",
                value: draftWsKind,
                title: "временный каталог удаляется после завершения; dir/worktree — сохраняются",
                onChange: function (e) { setDraftWsKind(e.target.value); },
                onKeyDown: onCreateKeyDown,
              },
              el("option", { value: "scratch" }, "временный (scratch)"),
              el("option", { value: "dir" }, "каталог (dir)"),
              el("option", { value: "worktree" }, "git worktree")
            )
          ),
          draftWsKind !== "scratch" ? el("label", { className: "hlv-field" },
            el("span", { className: "hlv-field-label" }, "Путь"),
            el("input", {
              className: "hlv-input",
              value: draftWsPath,
              placeholder: draftWsKind === "dir"
                ? "/путь/к/каталогу"
                : "/путь/к/репозиторию",
              onChange: function (e) { setDraftWsPath(e.target.value); },
              onKeyDown: onCreateKeyDown,
            })
          ) : null
        ),
        draftWsKind === "scratch" ? el("div", { className: "hlv-warn" },
          "воркспейс и все файлы в нём будут удалены после завершения задачи") : null,
        el("div", { className: "hlv-modal-row" },
          createNote.text ? el("span", {
            className: "hlv-composer-note " + createNote.kind,
          }, createNote.text) : null,
          el("button", {
            type: "button",
            className: "hlv-btn",
            disabled: createBusy,
            onClick: closeCreate,
          }, "отмена"),
          el("button", {
            type: "button",
            className: "hlv-btn hlv-btn-primary",
            disabled: createBusy,
            onClick: submitCreate,
          }, createBusy ? "создание…" : "создать")
        ),
        el("div", { className: "hlv-modal-hint" },
          draftStatus === "ready"
            ? "состояние ready — задачу сразу подхватит dispatcher"
            : "задача создастся в состоянии " + draftStatus + " и не уйдёт в работу сама")
      )
    );

    // Left column: the search field sits above the scrolling task list and does
    // not scroll with it.
    var leftColumn = el(
      "div",
      { className: "hlv-left" },
      searchBox,
      list
    );

    return el(
      "div",
      { className: "hlv-root" },
      header,
      el("div", { className: "hlv-main" }, leftColumn, rightPane),
      createDialog
    );
  }

  var reg = window.__HERMES_PLUGINS__;
  if (reg && reg.register) {
    reg.register("hermes-logs-viewer", Page);
  } else {
    window.console.error("[hermes-logs-viewer] __HERMES_PLUGINS__.register missing");
  }
})();
