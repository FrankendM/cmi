// ============================================================
//  studyhub.jsx — Courses / Subjects Feature
//  Sprint feature by: Frankent M. Maratas
//
//  Components:
//    CoursesPage            — browse all courses, join/leave, create
//    CourseDetailModal      — view shared schedules, member count
//    ManageCourseModal      — admin: post schedules, manage members, labels
//    CreateCourseModal      — admin: create a new course
//    CourseLabelPanel       — manage labels attached to a course calendar
//
//  Rules:
//    - A "Course" is backed by an Organization (uses org API)
//      plus a shared Calendar for schedules (uses cal API).
//    - Only admins (owners) can post schedules and see member list.
//    - Members can see shared schedules and add them to their own calendar.
//    - Everyone can see the total member count but NOT who the members are.
//    - Labels (users.v2.UserLabelService) can be attached to course calendars.
//    - No join-request flow — anyone can join directly.
//
//  API bases:
//    Organizations  → /organizations.v2.*
//    Calendars      → /calendars.v2.*
//    Labels         → /users.v2.UserLabelService
//    Profiles       → /users.v2.UserProfileService
//
//  Requires: app.jsx loaded first (apiCall, calApi, PALETTE,
//            fmtDate, fmtTime, strId, avatarColor, showToast,
//            icalToEvents, eventsToIcalB64, addOwnedCalendarId,
//            addJoinedCalendarId, removeCalendarId, etc.)
// ============================================================

// ─── API HELPERS ──────────────────────────────────────────────────
const CRS_ORG_BASE     = "/organizations.v2.OrganizationService";
const CRS_MEM_BASE     = "/organizations.v2.OrganizationMembershipService";
const CRS_ORGCAL_BASE  = "/organizations.v2.OrganizationCalendarService";
const CRS_LABEL_BASE   = "/users.v2.UserLabelService";
const CRS_PROFILE_BASE = "/users.v2.UserProfileService";

const crsOrgApi     = (m, b, s) => apiCall(`${CRS_ORG_BASE}/${m}`, b, s);
const crsMemApi     = (m, b, s) => apiCall(`${CRS_MEM_BASE}/${m}`, b, s);
const crsOrgCalApi  = (m, b, s) => apiCall(`${CRS_ORGCAL_BASE}/${m}`, b, s);
const crsLabelApi   = (m, b, s) => apiCall(`${CRS_LABEL_BASE}/${m}`, b, s);
const crsProfileApi = (m, b, s) => apiCall(`${CRS_PROFILE_BASE}/${m}`, b, s);

// ─── LOCAL STORAGE ────────────────────────────────────────────────
// Track course org IDs (owned + joined) per user in localStorage.
// Key: usc_<userId>_course_ids → { owned: string[], joined: string[] }
function loadCourseIds(userId) {
  try {
    const raw = localStorage.getItem(`usc_${userId}_course_ids`);
    return raw ? JSON.parse(raw) : { owned: [], joined: [] };
  } catch(e) { return { owned: [], joined: [] }; }
}
function saveCourseIds(userId, ids) {
  try { localStorage.setItem(`usc_${userId}_course_ids`, JSON.stringify(ids)); } catch(e) {}
}
function addOwnedCourseId(userId, orgId) {
  const ids = loadCourseIds(userId);
  const s = String(orgId);
  if (!ids.owned.includes(s)) { ids.owned.push(s); saveCourseIds(userId, ids); }
}
function addJoinedCourseId(userId, orgId) {
  const ids = loadCourseIds(userId);
  const s = String(orgId);
  if (!ids.joined.includes(s)) { ids.joined.push(s); saveCourseIds(userId, ids); }
}
function removeCourseId(userId, orgId) {
  const s = String(orgId);
  const ids = loadCourseIds(userId);
  ids.owned  = ids.owned.filter(id => id !== s);
  ids.joined = ids.joined.filter(id => id !== s);
  saveCourseIds(userId, ids);
}
function isCourseJoined(userId, orgId) {
  const ids = loadCourseIds(userId);
  const s = String(orgId);
  return ids.owned.includes(s) || ids.joined.includes(s);
}
function isCourseOwned(userId, orgId) {
  return loadCourseIds(userId).owned.includes(String(orgId));
}

// Track which calendar ID is the "schedule calendar" for a course org
// Key: usc_course_<orgId>_cal → calendarId string
function loadCourseCalId(orgId) {
  try { return localStorage.getItem(`usc_course_${orgId}_cal`) || null; } catch(e) { return null; }
}
function saveCourseCalId(orgId, calId) {
  try { localStorage.setItem(`usc_course_${orgId}_cal`, String(calId)); } catch(e) {}
}

// ─── HELPERS ──────────────────────────────────────────────────────
function crsColor(id) {
  return PALETTE[Math.abs(Number(id) || 0) % PALETTE.length];
}
function crsInitials(name) {
  return (name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

// ─── COURSES PAGE ─────────────────────────────────────────────────
function CoursesPage({ ctx }) {
  const { sessionId, currentUser, setModal, showToast } = ctx;

  const [allCourseIds,  setAllCourseIds]  = React.useState([]);
  const [courseDetails, setCourseDetails] = React.useState({});  // orgId → { id, name, description, memberCount }
  const [loading,       setLoading]       = React.useState(true);
  const [joinLoading,   setJoinLoading]   = React.useState(null);
  const [leaveLoading,  setLeaveLoading]  = React.useState(null);
  const [search,        setSearch]        = React.useState("");
  const [subTab,        setSubTab]        = React.useState("browse");
  const [deptFilter,    setDeptFilter]    = React.useState("all");
  const [refreshKey,    setRefreshKey]    = React.useState(0);

  const userId = currentUser.id;

  // Expose global refresh so modals can trigger a reload
  React.useEffect(() => {
    window.__refreshCourses = () => setRefreshKey(k => k + 1);
    return () => { delete window.__refreshCourses; };
  }, []);

  // ── Fetch all org IDs from server, filter those tagged as courses
  // Courses are identified by a description prefix "COURSE:" set on creation.
  async function loadCourses() {
    setLoading(true);
    try {
      const res = await crsOrgApi("GetOrganizations", {}, sessionId);
      const ids = (res.organizationIds || []).map(String);

      const details = {};
      await Promise.allSettled(ids.map(async (id) => {
        try {
          const d = await crsOrgApi("GetOrganization", { organizationId: Number(id) }, sessionId);
          // Only treat orgs whose description starts with "COURSE:" as courses
          if (!(d.description || "").startsWith("COURSE:")) return;
          const rawDesc     = (d.description || "").slice("COURSE:".length).trim();
          // Parse optional dept tag: "[DCISM] blah" → dept="DCISM", desc="blah"
          const deptMatch   = rawDesc.match(/^\[([^\]]+)\]\s*/);
          const dept        = deptMatch ? deptMatch[1].toUpperCase() : "";
          const visibleDesc = deptMatch ? rawDesc.slice(deptMatch[0].length) : rawDesc;

          // Fetch member count (public — just the count, not the list)
          let memberCount = 0;
          try {
            const mRes = await crsMemApi("GetOrganizationMembers", { organizationId: Number(id) }, sessionId);
            const raw = mRes.members || mRes.usernames || [];
            memberCount = Array.isArray(raw) ? raw.length : 0;
          } catch(e) {}

          details[id] = {
            id,
            name:        d.name || "",
            description: visibleDesc,
            dept,
            memberCount,
            createdAt:   d.createdAt || null,
          };
        } catch(e) {}
      }));

      setCourseDetails(details);
      setAllCourseIds(ids.filter(id => details[id]));
    } catch(e) {
      showToast("Failed to load subjects.", "error");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => { loadCourses(); }, [refreshKey]);

  // ── Join course directly (no approval needed)
  async function handleJoin(orgId) {
    const course = courseDetails[orgId];
    setJoinLoading(orgId);
    try {
      await crsMemApi("JoinOrganization", { organizationId: Number(orgId) }, sessionId);
      addJoinedCourseId(userId, orgId);

      // Also subscribe to the shared schedule calendar if one exists
      const calId = loadCourseCalId(orgId);
      if (calId) {
        addJoinedCalendarId(userId, calId);
      }

      showToast(`Enrolled in "${course?.name}"!`);
      setAllCourseIds(prev => [...prev]); // trigger re-render
      loadCourses();
    } catch(e) {
      showToast(e.message || "Failed to enroll.", "error");
    } finally {
      setJoinLoading(null);
    }
  }

  // ── Leave course
  async function handleLeave(orgId) {
    const name = courseDetails[orgId]?.name || "this course";
    if (!window.confirm(`Leave "${name}"?`)) return;
    setLeaveLoading(orgId);
    try {
      await crsMemApi("LeaveOrganization", { organizationId: Number(orgId) }, sessionId);
      removeCourseId(userId, orgId);

      // Also un-track the shared calendar and its org mapping
      const calId = loadCourseCalId(orgId);
      if (calId) {
        removeCalendarId(userId, calId);
        removeCalOrgEntry(userId, calId);
      }

      showToast(`Left "${name}"`);
      loadCourses();
    } catch(e) {
      showToast(e.message || "Failed to leave.", "error");
    } finally {
      setLeaveLoading(null);
    }
  }

  // ── Delete course (owner only)
  async function handleDelete(orgId) {
    const name = courseDetails[orgId]?.name || "this course";
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await crsOrgApi("DeleteOrganization", { organizationId: Number(orgId) }, sessionId);
      removeCourseId(userId, orgId);
      const calId = loadCourseCalId(orgId);
      if (calId) removeCalendarId(userId, calId);
      showToast(`Deleted "${name}"`);
      loadCourses();
    } catch(e) {
      showToast(e.message || "Failed to delete.", "error");
    }
  }

  // Hardcoded school labels — only these are valid dept tags
  const SCHOOL_LABELS = ["SAFAD","SAS","SHCP","SBE","SEd","SEng","SLG"];

  // ── Filtered list
  const filtered = allCourseIds.filter(id => {
    const d = courseDetails[id];
    if (!d) return false;
    if (subTab === "mine") {
      const q = search.toLowerCase();
      const matchSearch = !q || d.name?.toLowerCase().includes(q) || d.description?.toLowerCase().includes(q);
      const matchDept   = deptFilter === "all" || d.dept === deptFilter;
      return isCourseJoined(userId, id) && matchSearch && matchDept;
    }
    const q = search.toLowerCase();
    const matchSearch = !q || d.name?.toLowerCase().includes(q) || d.description?.toLowerCase().includes(q);
    const matchDept   = deptFilter === "all" || d.dept === deptFilter;
    return matchSearch && matchDept;
  });

  const myCount = allCourseIds.filter(id => isCourseJoined(userId, id)).length;

  return (
    <div>
      {/* ── Header row: sub-tabs left, create button right */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <div style={{ display:"flex", gap:4, background:"var(--surface2)", borderRadius:10, padding:3, border:"1px solid var(--border)" }}>
          {[
            ["browse", "📋 Browse"],
            ["mine",   `✅ My Courses${myCount ? ` (${myCount})` : ""}`],
          ].map(([t, l]) => (
            <div key={t} onClick={() => setSubTab(t)} style={{
              padding:"7px 20px", borderRadius:8, fontSize:13, fontWeight:600, cursor:"pointer",
              background: subTab === t ? "var(--accent)" : "transparent",
              color: subTab === t ? "#fff" : "var(--text2)",
              transition:"all .15s", whiteSpace:"nowrap",
            }}>{l}</div>
          ))}
        </div>
        <button className="btn btn-primary btn-sm"
          onClick={() => setModal({ type:"create-course" })}
          style={{ whiteSpace:"nowrap" }}>
          + New Course
        </button>
      </div>

      {/* ── Search + Dept filter bar */}
      <div style={{ display:"flex", alignItems:"stretch", gap:0, marginBottom:20,
        border:"1.5px solid var(--border)", borderRadius:10, overflow:"hidden",
        background:"var(--surface2)", maxWidth:520 }}>
        <select
          value={deptFilter}
          onChange={e => setDeptFilter(e.target.value)}
          style={{
            border:"none", borderRight:"1.5px solid var(--border)",
            background:"var(--surface)", color:"var(--text)",
            fontSize:13, fontWeight:600, padding:"10px 14px",
            outline:"none", cursor:"pointer", flexShrink:0,
            appearance:"auto",
          }}>
          <option value="all">All</option>
          {SCHOOL_LABELS.map(label => (
            <option key={label} value={label}>{label}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search courses…"
          style={{
            flex:1, border:"none", background:"transparent",
            color:"var(--text)", fontSize:13, padding:"10px 14px",
            outline:"none", minWidth:0,
          }}
        />
      </div>

      {/* ── Loading */}
      {loading && (
        <div style={{ textAlign:"center", padding:"48px 0", color:"var(--text3)", fontSize:13 }}>
          Loading subjects…
        </div>
      )}

      {/* ── Cards grid */}
      {!loading && (
        <div className="cards-grid">
          {filtered.length === 0 && (
            <div style={{ gridColumn:"1/-1", textAlign:"center", padding:"48px 0", color:"var(--text3)", fontSize:13 }}>
              {subTab === "mine" ? "You haven't enrolled in any subjects yet." : "No subjects found."}
            </div>
          )}

          {filtered.map(id => {
            const course = courseDetails[id];
            if (!course) return null;
            const joined   = isCourseJoined(userId, id);
            const owned    = isCourseOwned(userId, id);
            const col      = crsColor(id);
            const initials = crsInitials(course.name);
            const isJoining  = joinLoading  === id;
            const isLeaving  = leaveLoading === id;

            return (
              <div key={id} className="cal-card" style={{ display:"flex", flexDirection:"column" }}>

                {/* ── Card header: avatar + title + badge */}
                <div style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:10 }}>
                  <div style={{
                    width:42, height:42, borderRadius:10,
                    background: col + "28",
                    border: `1.5px solid ${col}50`,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontWeight:800, fontSize:14, color:col, flexShrink:0,
                    fontFamily:"var(--font-head)",
                  }}>
                    {initials}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{
                      fontFamily:"var(--font-head)", fontSize:15, fontWeight:700,
                      color:"var(--text)", lineHeight:1.3, marginBottom:5,
                      wordBreak:"break-word",
                    }}>
                      {course.name}
                    </div>
                    {/* Status badges */}
                    <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                      {owned && (
                        <span style={{ fontSize:10, padding:"2px 8px", borderRadius:20,
                          background: col+"28", color:col, fontWeight:700,
                          border:`1px solid ${col}44` }}>Admin</span>
                      )}
                      {joined && !owned && (
                        <span style={{ fontSize:10, padding:"2px 8px", borderRadius:20,
                          background:"rgba(52,211,153,0.15)", color:"var(--green)", fontWeight:700,
                          border:"1px solid rgba(52,211,153,0.3)" }}>Enrolled</span>
                      )}
                      {course.dept && (
                        <span style={{ fontSize:10, padding:"2px 8px", borderRadius:20,
                          background:"var(--surface3,var(--surface2))", color:"var(--text3)", fontWeight:600,
                          border:"1px solid var(--border)" }}>{course.dept}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── Description */}
                {course.description && (
                  <div style={{ fontSize:12, color:"var(--text2)", marginBottom:10, lineHeight:1.5 }}>
                    {course.description}
                  </div>
                )}

                {/* ── Member count */}
                <div style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:"var(--text3)", marginBottom:14 }}>
                  <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor" style={{ opacity:.7 }}>
                    <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/>
                  </svg>
                  <span>{course.memberCount} member{course.memberCount !== 1 ? "s" : ""} enrolled</span>
                </div>

                {/* ── Actions (pushed to bottom) */}
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginTop:"auto" }}>
                  {/* View schedules — enrolled or owner */}
                  {(joined || owned) && (
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => setModal({ type:"course-detail", data:{ orgId:id, course } })}>
                      📅 Schedules
                    </button>
                  )}

                  {/* Admin: manage */}
                  {owned && (
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => setModal({ type:"manage-course", data:{ orgId:id, course } })}>
                      ⚙ Manage
                    </button>
                  )}

                  {/* Admin: delete */}
                  {owned && (
                    <button className="btn btn-danger btn-sm"
                      onClick={() => handleDelete(id)}>
                      Delete
                    </button>
                  )}

                  {/* Join (not enrolled) */}
                  {!joined && !owned && (
                    <button className="btn btn-primary btn-sm"
                      onClick={() => handleJoin(id)} disabled={isJoining}>
                      {isJoining ? "Enrolling…" : "Enroll"}
                    </button>
                  )}

                  {/* Leave (member, not owner) */}
                  {joined && !owned && (
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => handleLeave(id)} disabled={isLeaving}
                      style={{ color:"var(--red)", borderColor:"rgba(248,113,113,0.3)" }}>
                      {isLeaving ? "Leaving…" : "Leave"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* ── Create placeholder card */}
          {subTab !== "mine" && (
            <div className="cal-card"
              style={{
                border:"1.5px dashed var(--border2)", cursor:"pointer",
                display:"flex", flexDirection:"column",
                alignItems:"center", justifyContent:"center",
                minHeight:160, gap:8,
              }}
              onClick={() => setModal({ type:"create-course" })}>
              <div style={{ fontSize:26, color:"var(--text3)", lineHeight:1 }}>+</div>
              <div style={{ color:"var(--text3)", fontSize:13, fontWeight:600 }}>Create Course</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── COURSE DETAIL MODAL ─────────────────────────────────────────
// Members view: see shared schedules + add them to personal calendar
function CourseDetailModal({ ctx, orgId, course }) {
  const { sessionId, currentUser, closeModal, showToast, refreshCalendars, setCalOrgEntry } = ctx;

  const [sharedCals,  setSharedCals]  = React.useState([]); // { id, name, color, events[] }
  const [calId,       setCalId]       = React.useState(null);
  const [loading,     setLoading]     = React.useState(true);
  const [addingId,    setAddingId]    = React.useState(null);
  const [memberCount, setMemberCount] = React.useState(course.memberCount || 0);

  const userId = currentUser.id;
  const col    = crsColor(orgId);

  React.useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      // 1. Get shared calendars for this org
      const calRes = await crsOrgCalApi("GetOrganizationCalendars", { organizationId: Number(orgId) }, sessionId);
      const calIds = (calRes.calendarIds || []).map(String);

      // 2. Fetch each calendar's details + events
      const cals = [];
      for (const cid of calIds) {
        try {
          const c = await calApi("GetCalendar", { calendarId: Number(cid) }, sessionId);
          const evts = icalToEvents(c.ical || "", cid)
            .filter(e => !(e.title || "").startsWith("TASK:"))
            .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
          const color = c.color ? "#" + c.color : col;
          cals.push({ id: cid, name: c.name || `Calendar #${cid}`, description: c.description || "", color, events: evts });
          if (!calId) saveCourseCalId(orgId, cid);
        } catch(e) {}
      }
      setSharedCals(cals);
      if (cals.length > 0) setCalId(cals[0].id);

      // 3. Member count refresh
      try {
        const mRes = await crsMemApi("GetOrganizationMembers", { organizationId: Number(orgId) }, sessionId);
        const raw = mRes.members || mRes.usernames || [];
        setMemberCount(Array.isArray(raw) ? raw.length : 0);
      } catch(e) {}

    } catch(e) {
      showToast("Failed to load schedules.", "error");
    } finally {
      setLoading(false);
    }
  }

  // Add a specific shared calendar to user's personal calendars
  async function handleAddCalendar(cid) {
    setAddingId(cid);
    try {
      addJoinedCalendarId(userId, cid);
      // Tag this cal as belonging to this org/course so the filter pill groups it correctly
      if (setCalOrgEntry) setCalOrgEntry(cid, orgId, course.name, true);
      if (refreshCalendars) await refreshCalendars();
      showToast(`Calendar added to your schedule!`);
    } catch(e) {
      showToast("Failed to add calendar.", "error");
    } finally {
      setAddingId(null);
    }
  }

  const now = new Date();

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{ maxHeight:"90vh", display:"flex", flexDirection:"column" }}>
        <div className="modal-header">
          <div style={{ display:"flex", alignItems:"center", gap:12, flex:1, minWidth:0 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:col+"22", border:`1.5px solid ${col}55`,
              display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:14, color:col, flexShrink:0 }}>
              {crsInitials(course.name)}
            </div>
            <div style={{ minWidth:0 }}>
              <div className="modal-title" style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{course.name}</div>
              <div style={{ fontSize:12, color:"var(--text3)", marginTop:1 }}>
                👥 {memberCount} member{memberCount !== 1 ? "s" : ""} enrolled
              </div>
            </div>
          </div>
          <button className="close-btn" onClick={closeModal}>✕</button>
        </div>

        <div className="modal-body" style={{ overflowY:"auto", flex:1 }}>
          {loading ? (
            <div style={{ textAlign:"center", padding:"48px 0", color:"var(--text3)", fontSize:13 }}>Loading schedules…</div>
          ) : sharedCals.length === 0 ? (
            <div className="empty-state" style={{ padding:"48px 0" }}>
              <div className="empty-icon">📚</div>
              <div className="empty-title">No schedules posted yet</div>
              <div style={{ fontSize:13, color:"var(--text3)" }}>The course admin hasn't shared any calendars yet.</div>
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
              {sharedCals.map(cal => {
                const upcoming = cal.events.filter(e => new Date(e.startTime) >= now);
                const past     = cal.events.filter(e => new Date(e.startTime) < now);
                const alreadyAdded = loadCalendarIds(userId).joined.includes(String(cal.id)) ||
                                     loadCalendarIds(userId).owned.includes(String(cal.id));
                return (
                  <div key={cal.id} style={{ borderRadius:12, border:"1px solid var(--border)", overflow:"hidden" }}>
                    {/* Calendar header */}
                    <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px",
                      background:"var(--surface2)", borderBottom:"1px solid var(--border)" }}>
                      <div style={{ width:12, height:12, borderRadius:"50%", background:cal.color, flexShrink:0 }} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:14, fontWeight:700, color:"var(--text)" }}>{cal.name}</div>
                        {cal.description && <div style={{ fontSize:12, color:"var(--text3)" }}>{cal.description}</div>}
                      </div>
                      <div style={{ fontSize:12, color:"var(--text3)", marginRight:8 }}>
                        {cal.events.length} event{cal.events.length !== 1 ? "s" : ""}
                      </div>
                      {!alreadyAdded && (
                        <button className="btn btn-primary btn-sm"
                          onClick={() => handleAddCalendar(cal.id)}
                          disabled={addingId === cal.id}>
                          {addingId === cal.id ? "Adding…" : "➕ Subscribe"}
                        </button>
                      )}
                      {alreadyAdded && (
                        <span style={{ fontSize:12, color:"var(--green)", fontWeight:600 }}>✓ Subscribed</span>
                      )}
                    </div>

                    {/* Events list */}
                    <div style={{ padding:"8px 0" }}>
                      {cal.events.length === 0 ? (
                        <div style={{ textAlign:"center", padding:"20px 0", color:"var(--text3)", fontSize:13 }}>
                          No events yet
                        </div>
                      ) : (
                        <>
                          {upcoming.length > 0 && (
                            <div style={{ padding:"0 16px" }}>
                              <div style={{ fontSize:11, fontWeight:700, color:"var(--text3)", letterSpacing:1,
                                textTransform:"uppercase", margin:"8px 0 8px" }}>
                                Upcoming · {upcoming.length}
                              </div>
                              {upcoming.map(e => <CourseEventRow key={e.id} event={e} col={cal.color} />)}
                            </div>
                          )}
                          {past.length > 0 && (
                            <div style={{ padding:"0 16px", marginTop: upcoming.length > 0 ? 12 : 0 }}>
                              <div style={{ fontSize:11, fontWeight:700, color:"var(--text3)", letterSpacing:1,
                                textTransform:"uppercase", margin:"8px 0 8px", opacity:.6 }}>
                                Past · {past.length}
                              </div>
                              {past.map(e => <CourseEventRow key={e.id} event={e} col={cal.color} dim />)}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={closeModal}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Single schedule event row (read-only for members)
function CourseEventRow({ event, col, dim }) {
  return (
    <div style={{
      borderLeft:`3px solid ${dim ? col+"55" : col}`,
      paddingLeft:14, marginBottom:8,
      background:"var(--surface2)", borderRadius:"0 10px 10px 0",
      padding:"10px 14px",
      opacity: dim ? 0.6 : 1,
    }}>
      <div style={{ fontWeight:600, fontSize:13, marginBottom:2 }}>
        {event.isImportant ? "⭐ " : ""}{event.title}
      </div>
      <div style={{ fontSize:12, color:"var(--text3)" }}>
        {fmtDate(event.startTime)} · {fmtTime(event.startTime)} – {fmtTime(event.endTime)}
        {event.location ? ` · 📍 ${event.location}` : ""}
      </div>
      {event.description && (
        <div style={{ fontSize:12, color:"var(--text2)", marginTop:4, lineHeight:1.5 }}>
          {event.description}
        </div>
      )}
    </div>
  );
}

// ─── MANAGE COURSE MODAL (ADMIN ONLY) ────────────────────────────
// Admin: post schedules, view members, manage labels, update info
function ManageCourseModal({ ctx, orgId, course }) {
  const { sessionId, currentUser, closeModal, showToast, myCalendars } = ctx;

  const [section, setSection]           = React.useState("calendars"); // "calendars" | "members" | "settings"
  const [sharedCalIds, setSharedCalIds] = React.useState([]);
  const [calLoading,   setCalLoading]   = React.useState(true);
  const [toggleLoading,setToggleLoading]= React.useState(null);
  const [members, setMembers]           = React.useState([]);
  const [memberLoading, setMemberLoading] = React.useState(false);

  // Settings form
  const [settingName, setSettingName]   = React.useState(course.name);
  const [settingDesc, setSettingDesc]   = React.useState(() => {
    return (course.description || "").replace(/^\[[^\]]+\]\s*/, "");
  });
  const [settingDept, setSettingDept]   = React.useState(() => {
    const m = (course.description || "").match(/^\[([^\]]+)\]/);
    return m ? m[1] : "";
  });
  const [settingSaving, setSettingSaving] = React.useState(false);

  const col    = crsColor(orgId);
  const userId = currentUser.id;

  // Use the app-level calendar list (already fetched at login, same as ManageOrgModal)
  const ownedCals = (myCalendars ? myCalendars() : []).filter(c => c.isOwner);

  React.useEffect(() => { loadSharedCals(); }, []);
  React.useEffect(() => {
    if (section === "members") loadMembers();
  }, [section]);

  async function loadSharedCals() {
    setCalLoading(true);
    try {
      const res = await crsOrgCalApi("GetOrganizationCalendars", { organizationId: Number(orgId) }, sessionId);
      setSharedCalIds((res.calendarIds || []).map(String));
    } catch(e) {
      setSharedCalIds([]);
    } finally {
      setCalLoading(false);
    }
  }

  async function toggleCalendar(calId) {
    setToggleLoading(calId);
    try {
      await crsOrgCalApi("ToggleShareUserCalendar", {
        organizationId: Number(orgId),
        calendarId:     Number(calId),
      }, sessionId);
      const isNowShared = !sharedCalIds.includes(String(calId));
      setSharedCalIds(prev =>
        isNowShared ? [...prev, String(calId)] : prev.filter(id => id !== String(calId))
      );
      // Persist the shared calendar ID so members can find it
      if (isNowShared) saveCourseCalId(orgId, calId);
      showToast(isNowShared ? "Calendar shared to course!" : "Calendar removed from course.");
    } catch(e) {
      showToast(e.message || "Failed to toggle calendar.", "error");
    } finally {
      setToggleLoading(null);
    }
  }

  async function loadMembers() {
    setMemberLoading(true);
    try {
      const res = await crsMemApi("GetOrganizationMembers", { organizationId: Number(orgId) }, sessionId);
      setMembers(res.members || res.usernames || []);
    } catch(e) {
      setMembers([]);
    } finally {
      setMemberLoading(false);
    }
  }

  async function handleSaveSettings() {
    setSettingSaving(true);
    try {
      const deptTag     = settingDept.trim().toUpperCase();
      const descPayload = deptTag
        ? `[${deptTag}]${settingDesc.trim() ? " " + settingDesc.trim() : ""}`
        : settingDesc.trim();
      await crsOrgApi("UpdateOrganization", {
        organizationId: Number(orgId),
        name:           settingName || undefined,
        description:    `COURSE:${descPayload}`,
      }, sessionId);
      showToast("Course updated!");
      if (typeof window.__refreshCourses === "function") window.__refreshCourses();
    } catch(e) {
      showToast(e.message || "Failed to update.", "error");
    } finally {
      setSettingSaving(false);
    }
  }

  const sectionBtn = (s, label) => ({
    style: {
      padding:"7px 16px", borderRadius:8, fontSize:13, fontWeight:600, cursor:"pointer", border:"none",
      background: section === s ? "var(--accent)" : "transparent",
      color: section === s ? "#fff" : "var(--text2)",
      transition:"all .15s",
    },
    onClick: () => setSection(s),
  });

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()} style={{ maxHeight:"90vh", overflow:"hidden", display:"flex", flexDirection:"column" }}>
        <div className="modal-header">
          <div style={{ display:"flex", alignItems:"center", gap:10, flex:1 }}>
            <div style={{ width:10, height:10, borderRadius:"50%", background:col }} />
            <div className="modal-title">Manage: {course.name}</div>
            <span style={{ fontSize:10, padding:"2px 8px", borderRadius:4, background:col+"22", color:col, fontWeight:700, border:`1px solid ${col}44` }}>Admin</span>
          </div>
          <button className="close-btn" onClick={closeModal}>✕</button>
        </div>

        {/* Section tabs */}
        <div style={{ display:"flex", gap:2, padding:"0 24px 0", background:"var(--surface2)", borderBottom:"1px solid var(--border)", flexWrap:"wrap" }}>
          <button {...sectionBtn("calendars", "📚 Calendars")}>📚 Calendars</button>
          <button {...sectionBtn("members", "👥 Members")}>👥 Members</button>
          <button {...sectionBtn("settings", "⚙️ Settings")}>⚙️ Settings</button>
        </div>

        <div className="modal-body" style={{ overflowY:"auto", flex:1 }}>

          {/* ── CALENDARS ── */}
          {section === "calendars" && (
            <div>
              <div style={{ fontSize:13, color:"var(--text2)", marginBottom:14 }}>
                Share your calendars with this course so enrolled members can see them.
              </div>

              {calLoading ? (
                <div style={{ textAlign:"center", padding:"24px 0", color:"var(--text3)", fontSize:13 }}>Loading…</div>
              ) : ownedCals.length === 0 ? (
                <div className="empty-state" style={{ padding:"28px 0" }}>
                  <div className="empty-icon">📚</div>
                  <div className="empty-title">No calendars</div>
                  <div style={{ fontSize:13, color:"var(--text3)" }}>Create a calendar first to share it here.</div>
                </div>
              ) : (
                ownedCals.map(cal => {
                  const isShared  = sharedCalIds.includes(String(cal.id));
                  const isLoading = toggleLoading === String(cal.id);
                  const displayName = (cal.name && cal.name.trim()) ? cal.name.trim() : `Calendar #${cal.id}`;
                  return (
                    <div key={cal.id} style={{
                      display:"flex", alignItems:"center", gap:12, padding:"11px 14px",
                      borderRadius:10, marginBottom:8,
                      background: isShared ? "rgba(52,211,153,0.07)" : "var(--surface2)",
                      border: isShared ? "1px solid rgba(52,211,153,0.25)" : "1px solid var(--border)",
                    }}>
                      {/* Color dot */}
                      <div style={{ width:10, height:10, borderRadius:"50%", background:cal.color || "#6c63ff", flexShrink:0 }} />
                      {/* Name — always visible */}
                      <div style={{ flex:1, minWidth:0, fontSize:13, fontWeight:600, color:"var(--text)",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {displayName}
                      </div>
                      {/* Shared badge */}
                      {isShared && (
                        <span style={{ fontSize:11, color:"var(--green)", fontWeight:700, flexShrink:0, whiteSpace:"nowrap" }}>✓ Shared</span>
                      )}
                      {/* Share / Unshare button — fixed width, compact */}
                      <button
                        onClick={() => toggleCalendar(String(cal.id))}
                        disabled={isLoading}
                        style={{
                          flexShrink:0, width:76, padding:"5px 0", fontSize:12, fontWeight:600,
                          borderRadius:7, border:"1px solid", cursor:"pointer",
                          background: isLoading ? "transparent" : isShared ? "transparent" : "var(--accent)",
                          color: isLoading ? "var(--text3)" : isShared ? "var(--red)" : "#fff",
                          borderColor: isLoading ? "var(--border)" : isShared ? "rgba(248,113,113,0.45)" : "var(--accent)",
                          transition:"all .15s",
                        }}>
                        {isLoading ? "…" : isShared ? "Unshare" : "Share"}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* ── MEMBERS (admin-only: sees the full list) ── */}
          {section === "members" && (
            <div>
              <div style={{ fontSize:13, color:"var(--text2)", marginBottom:14 }}>
                All enrolled members of <strong style={{ color:"var(--text)" }}>{course.name}</strong>.
                Only you (the admin) can see this list.
              </div>
              {memberLoading ? (
                <div style={{ textAlign:"center", padding:"24px 0", color:"var(--text3)", fontSize:13 }}>Loading members…</div>
              ) : members.length === 0 ? (
                <div className="empty-state" style={{ padding:"24px 0" }}>
                  <div className="empty-icon">👥</div>
                  <div style={{ fontSize:13, color:"var(--text3)" }}>No members yet.</div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize:12, color:"var(--text3)", marginBottom:10 }}>
                    {members.length} member{members.length !== 1 ? "s" : ""}
                  </div>
                  {members.map((m, i) => {
                    const uname = typeof m === "string" ? m : (m.username || m.name || m.email || `Member ${i + 1}`);
                    const mc = avatarColor(uname);
                    const init = (uname[0] || "?").toUpperCase();
                    return (
                      <div key={i} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0",
                        borderBottom:"1px solid var(--border)" }}>
                        <div style={{ width:34, height:34, borderRadius:"50%", background:mc,
                          display:"flex", alignItems:"center", justifyContent:"center",
                          fontWeight:700, fontSize:13, color:"#fff", flexShrink:0 }}>
                          {init}
                        </div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {uname}
                          </div>
                          <div style={{ fontSize:11, color:"var(--text3)" }}>Enrolled</div>
                        </div>
                        <button className="btn btn-ghost btn-sm"
                          style={{ fontSize:11, color:"var(--red)", borderColor:"var(--red)" }}
                          onClick={() => handleKick(uname)}>
                          Kick
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── SETTINGS ── */}
          {section === "settings" && (
            <div style={{ maxWidth:480 }}>
              <div className="form-group">
                <label className="form-label">Course Name</label>
                <input className="form-input" value={settingName}
                  onChange={e => setSettingName(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Department <span style={{ color:"var(--text3)", fontWeight:400 }}>(e.g. DCISM, SAS, Engineering)</span></label>
                <input className="form-input" value={settingDept}
                  onChange={e => setSettingDept(e.target.value)}
                  placeholder="e.g. DCISM" style={{ maxWidth:200 }} />
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <input className="form-input" value={settingDesc}
                  onChange={e => setSettingDesc(e.target.value)}
                  placeholder="e.g. 2nd Year Computer Science" />
              </div>
              <button className="btn btn-primary btn-sm" onClick={handleSaveSettings} disabled={settingSaving}>
                {settingSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={closeModal}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── COURSE LABEL PANEL ───────────────────────────────────────────
// Admin sub-panel: create labels, attach/detach them to this course calendar
function CourseLabelPanel({ sessionId, calId, showToast }) {
  const [myLabels,  setMyLabels]  = React.useState([]); // all user labels
  const [calLabels, setCalLabels] = React.useState([]); // label IDs attached to calId
  const [loading,   setLoading]   = React.useState(true);
  const [newName,   setNewName]   = React.useState("");
  const [newColor,  setNewColor]  = React.useState("#6c63ff");
  const [creating,  setCreating]  = React.useState(false);

  React.useEffect(() => { loadLabels(); }, []);

  async function loadLabels() {
    setLoading(true);
    try {
      const allRes = await crsProfileApi("GetUserLabels", {}, sessionId);
      const ids = (allRes.userLabelIds || []).map(String);
      const details = await Promise.all(ids.map(async lid => {
        try {
          const d = await crsLabelApi("GetUserLabel", { userLabelId: Number(lid) }, sessionId);
          return { id: lid, name: d.name, color: d.color ? (d.color.startsWith("#") ? d.color : "#" + d.color) : "#6c63ff" };
        } catch(e) { return null; }
      }));
      setMyLabels(details.filter(Boolean));

      const calRes = await crsProfileApi("GetUserCalendarLabels", { calendarId: Number(calId) }, sessionId);
      setCalLabels((calRes.userLabelIds || []).map(String));
    } catch(e) {
      showToast("Failed to load labels.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) { showToast("Label name required.", "error"); return; }
    setCreating(true);
    try {
      const res = await crsLabelApi("CreateUserLabel", {
        name:  newName.trim(),
        color: newColor.replace("#", ""),
      }, sessionId);
      const newId = String(res.userLabelId);
      const newLabel = { id: newId, name: newName.trim(), color: newColor };
      setMyLabels(prev => [...prev, newLabel]);
      setNewName(""); setNewColor("#6c63ff");
      showToast("Label created!");
    } catch(e) {
      showToast(e.message || "Failed to create label.", "error");
    } finally {
      setCreating(false);
    }
  }

  async function toggleAttach(labelId) {
    const attached = calLabels.includes(labelId);
    try {
      if (attached) {
        await crsLabelApi("DetachUserLabel", { userLabelId: Number(labelId), calendarId: Number(calId) }, sessionId);
        setCalLabels(prev => prev.filter(id => id !== labelId));
        showToast("Label detached.");
      } else {
        await crsLabelApi("AttachUserLabel", { userLabelId: Number(labelId), calendarId: Number(calId) }, sessionId);
        setCalLabels(prev => [...prev, labelId]);
        showToast("Label attached!");
      }
    } catch(e) {
      showToast(e.message || "Failed to update label.", "error");
    }
  }

  async function handleDelete(labelId) {
    if (!window.confirm("Delete this label?")) return;
    try {
      await crsLabelApi("DeleteUserLabel", { userLabelId: Number(labelId) }, sessionId);
      setMyLabels(prev => prev.filter(l => l.id !== labelId));
      setCalLabels(prev => prev.filter(id => id !== labelId));
      showToast("Label deleted.");
    } catch(e) {
      showToast(e.message || "Failed to delete label.", "error");
    }
  }

  return (
    <div>
      <div style={{ fontSize:13, color:"var(--text2)", marginBottom:14 }}>
        Create labels and attach them to this subject's calendar. Members will see attached labels on their schedule view.
      </div>

      {/* Create label form */}
      <div style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:12, padding:14, marginBottom:18 }}>
        <div style={{ fontSize:12, fontWeight:700, color:"var(--text3)", textTransform:"uppercase", letterSpacing:1, marginBottom:10 }}>New Label</div>
        <div style={{ display:"flex", gap:10, alignItems:"flex-end", flexWrap:"wrap" }}>
          <div className="form-group" style={{ flex:1, minWidth:160, margin:0 }}>
            <label className="form-label" style={{ marginBottom:4 }}>Label</label>
            <select className="select" value={newName} onChange={e => setNewName(e.target.value)}>
              <option value="">— Select label —</option>
              {["SAFAD","SAS","SHCP","SBE","SEd","SEng","SLG"].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label" style={{ marginBottom:4 }}>Color</label>
            <div style={{ display:"flex", gap:5 }}>
              {PALETTE.map(c => (
                <div key={c} onClick={() => setNewColor(c)}
                  style={{ width:22, height:22, borderRadius:"50%", background:c, cursor:"pointer",
                    border:newColor===c?"2.5px solid #fff":"2.5px solid transparent",
                    boxShadow:newColor===c?"0 0 0 2px "+c:"none", transition:"all .15s" }} />
              ))}
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={creating}>
            {creating ? "Creating…" : "+ Create"}
          </button>
        </div>
      </div>

      {/* Label list */}
      {loading ? (
        <div style={{ textAlign:"center", padding:"20px 0", color:"var(--text3)", fontSize:13 }}>Loading labels…</div>
      ) : myLabels.length === 0 ? (
        <div style={{ textAlign:"center", padding:"20px 0", color:"var(--text3)", fontSize:13 }}>No labels yet.</div>
      ) : (
        myLabels.map(lb => {
          const attached = calLabels.includes(lb.id);
          return (
            <div key={lb.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0",
              borderBottom:"1px solid var(--border)" }}>
              <div style={{ width:28, height:28, borderRadius:"50%", background:lb.color+"33",
                border:`1.5px solid ${lb.color}66`, display:"flex", alignItems:"center",
                justifyContent:"center", flexShrink:0 }}>
                <div style={{ width:12, height:12, borderRadius:"50%", background:lb.color }} />
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:600, color:"var(--text)" }}>{lb.name}</div>
                <div style={{ fontSize:11, color:lb.color }}>
                  {attached ? "Attached to this course" : "Not attached"}
                </div>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                <button
                  onClick={() => toggleAttach(lb.id)}
                  style={{
                    fontSize:11, padding:"4px 10px", borderRadius:6, cursor:"pointer", fontWeight:600,
                    background: attached ? "rgba(248,113,113,0.12)" : "rgba(52,211,153,0.12)",
                    color: attached ? "var(--red)" : "var(--green)",
                    border: attached ? "1px solid rgba(248,113,113,0.3)" : "1px solid rgba(52,211,153,0.3)",
                  }}>
                  {attached ? "Detach" : "Attach"}
                </button>
                <button className="btn btn-danger btn-sm" style={{ fontSize:11 }}
                  onClick={() => handleDelete(lb.id)}>
                  ✕
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ─── CREATE COURSE MODAL ──────────────────────────────────────────
function CreateCourseModal({ ctx }) {
  const { sessionId, currentUser, closeModal, showToast } = ctx;

  const [name,    setName]    = React.useState("");
  const [desc,    setDesc]    = React.useState("");
  const [dept,    setDept]    = React.useState("");
  const [error,   setError]   = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const userId = currentUser.id;

  async function handleCreate() {
    if (!name.trim()) { setError("Course name is required."); return; }
    setLoading(true); setError("");
    try {
      // Embed dept tag: "[DCISM] actual description"
      const deptTag     = dept.trim().toUpperCase();
      const descPayload = deptTag
        ? `[${deptTag}]${desc.trim() ? " " + desc.trim() : ""}`
        : desc.trim();
      const res = await crsOrgApi("CreateOrganization", {
        name:                name.trim(),
        description:         `COURSE:${descPayload}`,
        requiresJoinRequest: false,
      }, sessionId);

      const newOrgId = String(res.organizationId);
      addOwnedCourseId(userId, newOrgId);

      // Auto-join the org as owner (may be automatic server-side)
      try {
        await crsMemApi("JoinOrganization", { organizationId: Number(newOrgId) }, sessionId);
      } catch(e) {}

      showToast(`Subject "${name}" created!`);
      if (typeof window.__refreshCourses === "function") window.__refreshCourses();
      closeModal();
    } catch(e) {
      setError(e.message || "Failed to create course.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">Create Subject</div>
          <button className="close-btn" onClick={closeModal}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-msg">{error}</div>}
          <div className="form-group">
            <label className="form-label">Subject Name *</label>
            <input className="form-input" value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. CS 101 — Intro to Programming" />
          </div>
          <div className="form-group">
            <label className="form-label">School / Department</label>
            <select className="select" value={dept} onChange={e => setDept(e.target.value)} style={{ maxWidth:200 }}>
              <option value="">— Select school —</option>
              {["SAFAD","SAS","SHCP","SBE","SEd","SEng","SLG"].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Description <span style={{ color:"var(--text3)", fontWeight:400 }}>(optional)</span></label>
            <input className="form-input" value={desc}
              onChange={e => setDesc(e.target.value)}
              placeholder="e.g. 2nd Year, 1st Semester" />
          </div>
          <div style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px", marginTop:8 }}>
            <div style={{ fontSize:12, fontWeight:700, color:"var(--text2)", marginBottom:6 }}>What you can do as admin:</div>
            <ul style={{ margin:0, paddingLeft:18, fontSize:12, color:"var(--text3)", lineHeight:1.8 }}>
              <li>Post class schedules, exam dates, and announcements</li>
              <li>See the full member list and remove members</li>
              <li>Manage labels to categorize the course calendar</li>
            </ul>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
          <button className="btn btn-primary btn-block" onClick={handleCreate} disabled={loading}>
            {loading ? "Creating…" : "Create Subject"}
          </button>
        </div>
      </div>
    </div>
  );
}