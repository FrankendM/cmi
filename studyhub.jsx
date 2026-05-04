// ============================================================
//  studyhub.jsx — Study Hub Feature
//
//  Components:
//    StudyHubTab          — browse all courses, join/leave, create
//    CreateCourseModal    — create a new course
//    ManageCourseModal    — owner: push calendars, update settings
//    CourseDetailModal    — member: view shared calendars
//    CourseMembersModal   — view member list
//
//  API base: /organizations.v2.<Service>/<Method>
//  Requires: app.jsx loaded first (apiCall, PALETTE, fmtDate,
//            avatarColor, strId, showToast, sessionId, etc.)
//
//  Differences from organizations.jsx:
//    • "Organization" → "Course" throughout
//    • Adds `genre` field (department/school: SAS, SAFAD, SBMA…)
//    • Genre shown as a badge on each course card
//    • Genre filter added to Browse tab
// ============================================================

// ─── API HELPERS ──────────────────────────────────────────────────────────────
const COURSE_BASE        = "/organizations.v2.OrganizationService";
const COURSE_MEM_BASE    = "/organizations.v2.OrganizationMembershipService";
const COURSE_CAL_BASE    = "/organizations.v2.OrganizationCalendarService";

const courseApi       = (method, body, sid) => apiCall(`${COURSE_BASE}/${method}`,       body, sid);
const courseMemApi    = (method, body, sid) => apiCall(`${COURSE_MEM_BASE}/${method}`,    body, sid);
const courseCalApi    = (method, body, sid) => apiCall(`${COURSE_CAL_BASE}/${method}`,    body, sid);

// ─── AUDIT LOG ────────────────────────────────────────────────────────────────
function loadCourseAuditLog(courseId) {
  try { const r = localStorage.getItem(`usc_course_audit_${courseId}`); return r ? JSON.parse(r) : []; } catch(e) { return []; }
}
function addCourseAuditEntry(courseId, entry) {
  const log = loadCourseAuditLog(courseId);
  log.unshift({ ...entry, timestamp: new Date().toISOString() });
  try { localStorage.setItem(`usc_course_audit_${courseId}`, JSON.stringify(log.slice(0, 100))); } catch(e) {}
}

// ─── LOCAL STORAGE — track joined course IDs ──────────────────────────────────
function loadCourseIds(userId) {
  try {
    const raw = localStorage.getItem(`usc_${userId}_course_ids`);
    return raw ? JSON.parse(raw) : { owned: [], joined: [] };
  } catch(e) { return { owned: [], joined: [] }; }
}
function saveCourseIds(userId, ids) {
  try { localStorage.setItem(`usc_${userId}_course_ids`, JSON.stringify(ids)); } catch(e) {}
}
function addOwnedCourseId(userId, courseId) {
  const ids = loadCourseIds(userId);
  const s = String(courseId);
  if (!ids.owned.includes(s)) { ids.owned.push(s); saveCourseIds(userId, ids); }
}
function addJoinedCourseId(userId, courseId) {
  const ids = loadCourseIds(userId);
  const s = String(courseId);
  if (!ids.joined.includes(s)) { ids.joined.push(s); saveCourseIds(userId, ids); }
}
function removeCourseId(userId, courseId) {
  const s = String(courseId);
  const ids = loadCourseIds(userId);
  ids.owned  = ids.owned.filter(id => id !== s);
  ids.joined = ids.joined.filter(id => id !== s);
  saveCourseIds(userId, ids);
}
function isCourseJoined(userId, courseId) {
  const ids = loadCourseIds(userId);
  const s = String(courseId);
  return ids.owned.includes(s) || ids.joined.includes(s);
}
function isCourseOwned(userId, courseId) {
  return loadCourseIds(userId).owned.includes(String(courseId));
}

// ─── GENRE DEFINITIONS ────────────────────────────────────────────────────────
const GENRES = ["All", "SAS", "SAFAD", "SBMA", "SOM", "SOL", "SOE", "SNS", "Other"];

const GENRE_COLORS = {
  SAS:   "var(--blue)",
  SAFAD: "var(--pink)",
  SBMA:  "var(--green)",
  SOM:   "var(--yellow)",
  SOL:   "var(--orange)",
  SOE:   "var(--accent)",
  SNS:   "var(--red)",
  Other: "var(--text3)",
};

function genreColor(genre) {
  return GENRE_COLORS[genre] || "var(--text3)";
}

// ─── COURSE AVATAR HELPERS ────────────────────────────────────────────────────
function courseColor(id) {
  return PALETTE[Math.abs(Number(id) || 0) % PALETTE.length];
}
function courseInitials(name) {
  return (name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

// ─── STUDY HUB TAB ────────────────────────────────────────────────────────────
// Rendered inside app as a standalone page "studyhub"
function StudyHubTab({ ctx }) {
  const { sessionId, currentUser, setModal, showToast } = ctx;

  const [allCourses,    setAllCourses]    = React.useState([]);
  const [courseDetails, setCourseDetails] = React.useState({});
  const [loading,       setLoading]       = React.useState(true);
  const [joinLoading,   setJoinLoading]   = React.useState(null);
  const [leaveLoading,  setLeaveLoading]  = React.useState(null);
  const [search,        setSearch]        = React.useState("");
  const [subTab,        setSubTab]        = React.useState("browse");
  const [genreFilter,   setGenreFilter]   = React.useState("All");
  const [refreshKey,    setRefreshKey]    = React.useState(0);
  const [confirmDlg,    setConfirmDlg]    = React.useState(null);

  const userId = currentUser.id;

  React.useEffect(() => {
    window.__refreshCourses = () => setRefreshKey(k => k + 1);
    return () => { delete window.__refreshCourses; };
  }, []);

  // ── Fetch all course IDs then details
  async function loadCourses() {
    setLoading(true);
    try {
      const res = await courseApi("GetOrganizations", {}, sessionId);
      const ids = (res.organizationIds || []).map(String);

      const details = {};
      await Promise.allSettled(ids.map(async (id) => {
        try {
          const d = await courseApi("GetOrganization", { organizationId: Number(id) }, sessionId);
          const rawDesc = d.description || "";
          if (!rawDesc.startsWith("COURSE:")) return;
          const inner      = rawDesc.slice("COURSE:".length).trim();
          const genreMatch = inner.match(/^\[([^\]]+)\]\s*/);
          const genre      = genreMatch ? genreMatch[1] : "Other";
          const visDesc    = genreMatch ? inner.slice(genreMatch[0].length) : inner;
          details[id] = {
            id,
            name:        d.name || "",
            description: visDesc,
            genre,
            createdAt:   d.createdAt || null,
          };
        } catch(e) {}
      }));

      setCourseDetails(details);
      setAllCourses(ids.filter(id => details[id]));
    } catch(e) {
      showToast("Failed to load courses.", "error");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => { loadCourses(); }, [refreshKey]);

  // ── Join course
  async function handleJoin(courseId) {
    const course = courseDetails[courseId];
    setConfirmDlg({
      message: `Join "${course?.name}"?`,
      description: course?.description || undefined,
      onConfirm: async () => {
        setJoinLoading(courseId);
        try {
          await courseMemApi("JoinOrganization", { organizationId: Number(courseId) }, sessionId);
          addJoinedCourseId(userId, courseId);
          addCourseAuditEntry(courseId, { name: currentUser.name || currentUser.email, action: "joined" });
          showToast(`Joined "${course?.name}"!`);
          setAllCourses(prev => [...prev]);
        } catch(e) {
          const msg = e.message || "";
          if (msg.includes("1644") || msg.toLowerCase().includes("already exists") || msg.toLowerCase().includes("membership")) {
            addJoinedCourseId(userId, courseId);
            showToast(`You're already enrolled in "${course?.name}".`);
            setAllCourses(prev => [...prev]);
          } else {
            showToast(msg || "Failed to join course.", "error");
          }
        } finally {
          setJoinLoading(null);
        }
      }
    });
  }

  // ── Leave course
  function handleLeave(courseId) {
    const name = courseDetails[courseId]?.name || "this course";
    setConfirmDlg({
      message: `Leave "${name}"?`,
      description: "You will lose access to shared calendars from this course.",
      danger: true,
      confirmLabel: "Yes, Leave",
      onConfirm: async () => {
        setLeaveLoading(courseId);
        try {
          await courseMemApi("LeaveOrganization", { organizationId: Number(courseId) }, sessionId);
          removeCourseId(userId, courseId);
          addCourseAuditEntry(courseId, { name: currentUser.name || currentUser.email, action: "left" });
          showToast(`Left "${name}"`);
          setAllCourses(prev => [...prev]);
        } catch(e) {
          showToast(e.message || "Failed to leave.", "error");
        } finally {
          setLeaveLoading(null);
        }
      }
    });
  }

  // ── Delete course
  function handleDelete(courseId) {
    const name = courseDetails[courseId]?.name || "this course";
    setConfirmDlg({
      message: `Delete "${name}"?`,
      description: "This will permanently delete the course and cannot be undone.",
      danger: true,
      confirmLabel: "Yes, Delete",
      onConfirm: async () => {
        try {
          await courseApi("DeleteOrganization", { organizationId: Number(courseId) }, sessionId);
          removeCourseId(userId, courseId);
          showToast(`Deleted "${name}"`);
          if (typeof window.__refreshCourses === "function") window.__refreshCourses();
          setAllCourses(prev => prev.filter(id => id !== courseId));
        } catch(e) {
          showToast(e.message || "Failed to delete.", "error");
        }
      }
    });
  }

  // ── Filter
  const filteredCourses = allCourses.filter(id => {
    const d = courseDetails[id];
    if (!d) return false;
    if (subTab === "mine") return isCourseJoined(userId, id);
    const q = search.toLowerCase();
    const matchesSearch = !q || d.name?.toLowerCase().includes(q) || d.description?.toLowerCase().includes(q) || d.genre?.toLowerCase().includes(q);
    const matchesGenre  = genreFilter === "All" || d.genre === genreFilter;
    return matchesSearch && matchesGenre;
  });

  const myCourseCount = allCourses.filter(id => isCourseJoined(userId, id)).length;

  return (
    <div>
      {confirmDlg && (
        <ConfirmDialog {...confirmDlg} onClose={() => setConfirmDlg(null)} />
      )}

      {/* ── Header row: sub-tabs + Create button */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16, flexWrap:"wrap", gap:10 }}>
        <div style={{ display:"flex", gap:0, background:"var(--surface2)", borderRadius:10, padding:3, border:"1px solid var(--border)" }}>
          {[["browse","📚 Browse"], ["mine", `🎓 My Courses${myCourseCount ? ` (${myCourseCount})` : ""}`]].map(([t, l]) => (
            <div key={t} onClick={() => setSubTab(t)} style={{
              padding:"7px 18px", borderRadius:8, fontSize:13, fontWeight:600, cursor:"pointer",
              background: subTab===t ? "var(--accent)" : "transparent",
              color: subTab===t ? "#fff" : "var(--text2)",
              transition:"all .15s",
            }}>
              {l}
            </div>
          ))}
        </div>
        <button className="btn btn-primary btn-sm"
          onClick={() => setModal({ type:"create-course" })}>
          + New Course
        </button>
      </div>

      {/* ── Search + Genre filter (browse tab only) */}
      {subTab === "browse" && (
        <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
          <input
            className="form-input"
            placeholder="Search courses…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ maxWidth:280 }}
          />
          {/* Genre filter pills */}
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {GENRES.map(g => (
              <div key={g} onClick={() => setGenreFilter(g)} style={{
                padding:"5px 12px", borderRadius:20, fontSize:12, fontWeight:600, cursor:"pointer",
                border:`1.5px solid ${genreFilter===g ? genreColor(g) : "var(--border)"}`,
                background: genreFilter===g ? genreColor(g)+"22" : "transparent",
                color: genreFilter===g ? genreColor(g) : "var(--text3)",
                transition:"all .15s",
              }}>
                {g}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Loading */}
      {loading && (
        <div style={{ textAlign:"center", padding:"40px 0", color:"var(--text3)", fontSize:13 }}>
          Loading courses…
        </div>
      )}

      {/* ── Course cards */}
      {!loading && (
        <div className="cards-grid">
          {filteredCourses.length === 0 && (
            <div style={{ gridColumn:"1/-1", textAlign:"center", padding:"40px 0", color:"var(--text3)", fontSize:13 }}>
              {subTab === "mine" ? "You haven't joined any courses yet." : "No courses found."}
            </div>
          )}

          {filteredCourses.map(id => {
            const course    = courseDetails[id];
            if (!course) return null;
            const joined    = isCourseJoined(userId, id);
            const owned     = isCourseOwned(userId, id);
            const col       = courseColor(id);
            const initials  = courseInitials(course.name);
            const gc        = genreColor(course.genre);
            const isJoining = joinLoading  === id;
            const isLeaving = leaveLoading === id;

            return (
              <div key={id} className="cal-card" style={{ position:"relative", overflow:"hidden" }}>
                {/* Color stripe */}
                <div style={{ position:"absolute", top:0, left:0, right:0, height:3, background:col, borderRadius:"14px 14px 0 0" }} />

                {/* Course header */}
                <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10, marginTop:4 }}>
                  <div style={{
                    width:38, height:38, borderRadius:10, background:col+"22",
                    border:`1.5px solid ${col}55`, display:"flex", alignItems:"center",
                    justifyContent:"center", fontWeight:800, fontSize:14, color:col, flexShrink:0,
                    fontFamily:"var(--font-head)",
                  }}>
                    {initials}
                  </div>
                  <div style={{ minWidth:0, flex:1 }}>
                    <div className="cal-card-name" style={{ marginBottom:4 }}>{course.name}</div>
                    <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                      {/* Genre badge */}
                      {course.genre && (
                        <span style={{ fontSize:10, padding:"2px 8px", borderRadius:4, background:gc+"22", color:gc, fontWeight:700, border:`1px solid ${gc}44` }}>
                          {course.genre}
                        </span>
                      )}
                      {owned && (
                        <span style={{ fontSize:10, padding:"2px 7px", borderRadius:4, background:col+"22", color:col, fontWeight:700, border:`1px solid ${col}44` }}>Owner</span>
                      )}
                      {joined && !owned && (
                        <span style={{ fontSize:10, padding:"2px 7px", borderRadius:4, background:"rgba(52,211,153,0.15)", color:"var(--green)", fontWeight:700, border:"1px solid rgba(52,211,153,0.3)" }}>Enrolled</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Description */}
                {course.description && (
                  <div className="cal-card-type" style={{ marginBottom:10, lineHeight:1.5 }}>
                    {course.description}
                  </div>
                )}

                {/* Created date */}
                {course.createdAt && (
                  <div style={{ fontSize:11, color:"var(--text3)", marginBottom:12 }}>
                    Created {fmtDate(course.createdAt.seconds ? new Date(Number(course.createdAt.seconds) * 1000).toISOString() : course.createdAt)}
                  </div>
                )}

                {/* Actions */}
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  {joined && (
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => setModal({ type:"course-detail", data:{ courseId:id, course } })}>
                      View Calendars
                    </button>
                  )}
                  {joined && (
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => setModal({ type:"course-members", data:{ courseId:id, course } })}>
                      👥 Members
                    </button>
                  )}
                  {owned && (
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => setModal({ type:"manage-course", data:{ courseId:id, course } })}>
                      Manage
                    </button>
                  )}
                  {!joined && (
                    <button className="btn btn-primary btn-sm"
                      onClick={() => handleJoin(id)}
                      disabled={isJoining}>
                      {isJoining ? "Joining…" : "Enroll"}
                    </button>
                  )}
                  {joined && !owned && (
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => handleLeave(id)}
                      disabled={isLeaving}
                      style={{ color:"var(--red)", borderColor:"rgba(248,113,113,0.3)" }}>
                      {isLeaving ? "Leaving…" : "Leave"}
                    </button>
                  )}
                  {owned && (
                    <button className="btn btn-danger btn-sm"
                      onClick={() => handleDelete(id)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* Create new course card */}
          {subTab === "browse" && (
            <div className="cal-card"
              style={{ border:"1.5px dashed var(--border2)", cursor:"pointer", alignItems:"center",
                display:"flex", flexDirection:"column", justifyContent:"center", minHeight:120 }}
              onClick={() => setModal({ type:"create-course" })}>
              <div style={{ fontSize:24, marginBottom:6, opacity:.5 }}>🎓</div>
              <div style={{ color:"var(--text3)", fontSize:13, fontWeight:600 }}>Create Course</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── CREATE COURSE MODAL ──────────────────────────────────────────────────────
function CreateCourseModal({ ctx }) {
  const { sessionId, closeModal, showToast, currentUser } = ctx;
  const [form, setForm]       = React.useState({ name:"", description:"", genre:"SAS" });
  const [error, setError]     = React.useState("");
  const [loading, setLoading] = React.useState(false);

  async function submit() {
    if (!form.name.trim()) { setError("Course name is required."); return; }
    setLoading(true); setError("");
    try {
      const taggedDesc = `COURSE:[${form.genre}] ${form.description.trim()}`.trimEnd();
      const body = {
        name:                form.name.trim(),
        requiresJoinRequest: false,
        description:         taggedDesc,
      };
      const res = await courseApi("CreateOrganization", body, sessionId);
      const courseId = res.organizationId != null ? String(res.organizationId) : null;
      if (courseId) {
        addOwnedCourseId(currentUser.id, courseId);
        try { await courseMemApi("JoinOrganization", { organizationId: Number(courseId) }, sessionId); } catch(e) {}
      }
      showToast(`Course "${form.name.trim()}" created!`);
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
          <div className="modal-title">🎓 Create Course</div>
          <button className="close-btn" onClick={closeModal}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-msg">{error}</div>}

          <div className="form-group">
            <label className="form-label">Course Name *</label>
            <input className="form-input"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name:e.target.value }))}
              placeholder="e.g. Introduction to Computer Science" />
          </div>

          <div className="form-group">
            <label className="form-label">
              Description <span style={{ color:"var(--text3)", fontWeight:400 }}>(optional)</span>
            </label>
            <input className="form-input"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description:e.target.value }))}
              placeholder="What is this course about?" />
          </div>

          {/* Genre / Department */}
          <div className="form-group">
            <label className="form-label">Department / School (Genre) *</label>
            <select className="select"
              value={form.genre}
              onChange={e => setForm(f => ({ ...f, genre:e.target.value }))}>
              {GENRES.filter(g => g !== "All").map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <div style={{ fontSize:12, color:"var(--text3)", marginTop:5 }}>
              Select the department or school this course belongs to.
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading}>
            {loading ? "Creating…" : "Create Course"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── MANAGE COURSE MODAL ──────────────────────────────────────────────────────
// Owner-only: update metadata, push/unpush calendars, view members
function ManageCourseModal({ ctx, courseId, course }) {
  const { sessionId, closeModal, showToast, myCalendars, currentUser } = ctx;

  const [name,         setName]         = React.useState(course.name || "");
  const [description,  setDescription]  = React.useState(course.description || "");
  const [genre,        setGenre]        = React.useState(course.genre || "SAS");
  const [metaLoading,  setMetaLoading]  = React.useState(false);
  const [error,        setError]        = React.useState("");

  const [sharedCalIds,  setSharedCalIds]  = React.useState([]);
  const [calLoading,    setCalLoading]    = React.useState(true);
  const [toggleLoading, setToggleLoading] = React.useState(null);

  const [activeSection, setActiveSection] = React.useState("calendars");

  const [members,        setMembers]        = React.useState([]);
  const [membersLoading, setMembersLoading] = React.useState(false);

  const ownedCals = myCalendars().filter(c => c.isOwner);

  async function loadSharedCals() {
    setCalLoading(true);
    try {
      const res = await courseCalApi("GetOrganizationCalendars", { organizationId: Number(courseId) }, sessionId);
      setSharedCalIds((res.calendarIds || []).map(String));
    } catch(e) {
      setSharedCalIds([]);
    } finally {
      setCalLoading(false);
    }
  }

  async function loadMembers() {
    setMembersLoading(true);
    try {
      const res = await courseMemApi("GetOrganizationMembers", { organizationId: Number(courseId) }, sessionId);
      const ids = res.memberUserIds || [];
      const resolved = await Promise.all(ids.map(async (uid) => {
        try {
          const u = await apiCall("/users.v2.UserService/GetUser", { userId: uid }, sessionId);
          const name = [u.firstName, u.middleName, u.lastName].filter(Boolean).join(" ");
          return { id: uid, name: name || `User #${uid}` };
        } catch(e) {
          return { id: uid, name: `User #${uid}` };
        }
      }));
      setMembers(resolved);
    } catch(e) {
      setMembers([]);
    } finally {
      setMembersLoading(false);
    }
  }

  React.useEffect(() => { loadSharedCals(); }, [courseId]);
  React.useEffect(() => { if (activeSection === "members") loadMembers(); }, [activeSection, courseId]);

  async function toggleCalendar(calId) {
    setToggleLoading(calId);
    try {
      await courseCalApi("ToggleShareUserCalendar", { organizationId: Number(courseId), calendarId: Number(calId) }, sessionId);
      setSharedCalIds(prev =>
        prev.includes(String(calId)) ? prev.filter(id => id !== String(calId)) : [...prev, String(calId)]
      );
      const isNowShared = !sharedCalIds.includes(String(calId));
      showToast(isNowShared ? "Calendar shared to course!" : "Calendar removed from course.");
    } catch(e) {
      showToast(e.message || "Failed to toggle calendar sharing.", "error");
    } finally {
      setToggleLoading(null);
    }
  }

  async function saveSettings() {
    if (!name.trim()) { setError("Name is required."); return; }
    setMetaLoading(true); setError("");
    try {
      const taggedDesc = `COURSE:[${genre}] ${description.trim()}`.trimEnd();
      await courseApi("UpdateOrganization", {
        organizationId:      Number(courseId),
        name:                name.trim(),
        description:         taggedDesc,
        requiresJoinRequest: false,
      }, sessionId);
      showToast("Course updated!");
      if (typeof window.__refreshCourses === "function") window.__refreshCourses();
      closeModal();
    } catch(e) {
      setError(e.message || "Failed to update course.");
    } finally {
      setMetaLoading(false);
    }
  }

  const sectionBtnStyle = (s) => ({
    padding:"8px 16px", borderRadius:8, fontSize:13, fontWeight:600, cursor:"pointer",
    background: activeSection===s ? "var(--accent)" : "transparent",
    color: activeSection===s ? "#fff" : "var(--text2)",
    border:"none", transition:"all .15s",
  });

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display:"flex", alignItems:"center", gap:10, flex:1 }}>
            <div style={{ width:10, height:10, borderRadius:"50%", background:courseColor(courseId) }} />
            <div className="modal-title">Manage: {course.name}</div>
            {course.genre && (
              <span style={{ fontSize:11, padding:"2px 8px", borderRadius:4,
                background:genreColor(course.genre)+"22", color:genreColor(course.genre),
                fontWeight:700, border:`1px solid ${genreColor(course.genre)}44` }}>
                {course.genre}
              </span>
            )}
          </div>
          <button className="close-btn" onClick={closeModal}>✕</button>
        </div>

        {/* Section switcher */}
        <div style={{ padding:"0 24px", borderBottom:"1px solid var(--border)", display:"flex", gap:4, background:"var(--surface2)", overflowX:"auto" }}>
          <button style={sectionBtnStyle("calendars")}   onClick={() => setActiveSection("calendars")}>📅 Shared Calendars</button>
          <button style={sectionBtnStyle("members")}     onClick={() => setActiveSection("members")}>👥 Students</button>
          <button style={sectionBtnStyle("activity")}    onClick={() => setActiveSection("activity")}>📋 Activity</button>
          <button style={sectionBtnStyle("settings")}    onClick={() => setActiveSection("settings")}>⚙️ Settings</button>
        </div>

        <div className="modal-body">

          {/* ── CALENDARS ── */}
          {activeSection === "calendars" && (
            <div>
              <div style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
                Select which of your calendars to share with all students enrolled in <strong style={{ color:"var(--text)" }}>{course.name}</strong>.
              </div>
              {calLoading ? (
                <div style={{ textAlign:"center", padding:"24px 0", color:"var(--text3)", fontSize:13 }}>Loading calendars…</div>
              ) : ownedCals.length === 0 ? (
                <div style={{ textAlign:"center", padding:"24px 0", color:"var(--text3)", fontSize:13 }}>You don't own any calendars to share.</div>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  {ownedCals.map(cal => {
                    const isShared   = sharedCalIds.includes(String(cal.id));
                    const isToggling = toggleLoading === String(cal.id);
                    return (
                      <div key={cal.id}
                        style={{
                          display:"flex", alignItems:"center", gap:12,
                          padding:"12px 16px", borderRadius:12,
                          background: isShared ? "rgba(108,99,255,0.08)" : "var(--surface2)",
                          border: isShared ? "1.5px solid rgba(108,99,255,0.35)" : "1px solid var(--border)",
                          transition:"all .2s", cursor:"pointer",
                        }}
                        onClick={() => !isToggling && toggleCalendar(String(cal.id))}>
                        <div style={{ width:12, height:12, borderRadius:"50%", background:cal.color, flexShrink:0 }} />
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:14, fontWeight:600, color:"var(--text)" }}>{cal.name}</div>
                          {cal.description && (
                            <div style={{ fontSize:12, color:"var(--text3)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                              {cal.description}
                            </div>
                          )}
                        </div>
                        <div style={{
                          width:44, height:24, borderRadius:12, position:"relative",
                          background: isShared ? "var(--accent)" : "var(--surface3)",
                          border:"1px solid var(--border2)", transition:"all .2s", flexShrink:0,
                          opacity: isToggling ? 0.5 : 1,
                        }}>
                          <div style={{
                            position:"absolute", top:3, left: isShared ? 22 : 3,
                            width:16, height:16, borderRadius:"50%",
                            background: isShared ? "#fff" : "var(--text3)",
                            transition:"left .2s",
                          }} />
                        </div>
                        <div style={{ fontSize:12, fontWeight:600, color: isShared ? "var(--accent2)" : "var(--text3)", minWidth:72, textAlign:"right" }}>
                          {isToggling ? "Saving…" : isShared ? "Shared" : "Not shared"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── MEMBERS / STUDENTS ── */}
          {activeSection === "members" && (
            <div>
              <div style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
                All students enrolled in <strong style={{ color:"var(--text)" }}>{course.name}</strong>.
              </div>
              {membersLoading ? (
                <div style={{ textAlign:"center", padding:"24px 0", color:"var(--text3)", fontSize:13 }}>Loading students…</div>
              ) : members.length === 0 ? (
                <div style={{ textAlign:"center", padding:"32px 0", color:"var(--text3)" }}>
                  <div style={{ fontSize:28, marginBottom:8 }}>👤</div>
                  <div style={{ fontSize:13 }}>No students enrolled yet.</div>
                </div>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  <div style={{ fontSize:12, color:"var(--text3)", marginBottom:6 }}>{members.length} student{members.length !== 1 ? "s" : ""}</div>
                  {members.map((m, i) => (
                    <div key={m.id || i} style={{
                      display:"flex", alignItems:"center", gap:10,
                      padding:"10px 14px", borderRadius:10,
                      background:"var(--surface2)", border:"1px solid var(--border)",
                    }}>
                      <div style={{
                        width:30, height:30, borderRadius:"50%",
                        background: PALETTE[i % PALETTE.length] + "33",
                        border: `1.5px solid ${PALETTE[i % PALETTE.length]}55`,
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontSize:12, fontWeight:700, color: PALETTE[i % PALETTE.length], flexShrink:0,
                      }}>
                        {(m.name||"?")[0]?.toUpperCase()}
                      </div>
                      <div style={{ fontSize:14, fontWeight:600, color:"var(--text)" }}>{m.name}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── ACTIVITY ── */}
          {activeSection === "activity" && (() => {
            const log = loadCourseAuditLog(courseId);
            return (
              <div>
                <div style={{ fontSize:12, color:"var(--text3)", marginBottom:14 }}>
                  Enrollment activity for this course — visible only to you as owner.
                </div>
                {log.length === 0 ? (
                  <div style={{ textAlign:"center", padding:"40px 0", color:"var(--text3)" }}>
                    <div style={{ fontSize:32, marginBottom:8 }}>📋</div>
                    <div style={{ fontSize:13 }}>No activity recorded yet.</div>
                    <div style={{ fontSize:12, marginTop:4 }}>Enrollment and leave events will appear here.</div>
                  </div>
                ) : (
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {log.map((entry, i) => {
                      const isJoin = entry.action === "joined";
                      return (
                        <div key={i} style={{ display:"flex", alignItems:"center", gap:12,
                          padding:"10px 14px", borderRadius:10,
                          background:"var(--surface2)", border:"1px solid var(--border)" }}>
                          <div style={{ width:32, height:32, borderRadius:"50%", flexShrink:0,
                            background: PALETTE[i % PALETTE.length] + "22",
                            border:`1.5px solid ${PALETTE[i % PALETTE.length]}55`,
                            display:"flex", alignItems:"center", justifyContent:"center",
                            fontSize:12, fontWeight:700, color: PALETTE[i % PALETTE.length] }}>
                            {(entry.name||"?")[0].toUpperCase()}
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:13, fontWeight:600, color:"var(--text)",
                              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                              {entry.name || "Unknown"}
                            </div>
                            <div style={{ fontSize:11, color:"var(--text3)", marginTop:1 }}>
                              {new Date(entry.timestamp).toLocaleString("en-PH", {
                                month:"short", day:"numeric", year:"numeric",
                                hour:"2-digit", minute:"2-digit"
                              })}
                            </div>
                          </div>
                          <span style={{ fontSize:11, fontWeight:700, padding:"3px 9px", borderRadius:20,
                            whiteSpace:"nowrap", flexShrink:0,
                            background: isJoin ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)",
                            color: isJoin ? "var(--green)" : "var(--red)",
                            border: isJoin ? "1px solid rgba(52,211,153,0.3)" : "1px solid rgba(248,113,113,0.3)" }}>
                            {entry.action}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── SETTINGS ── */}
          {activeSection === "settings" && (
            <div>
              {error && <div className="error-msg">{error}</div>}
              <div className="form-group">
                <label className="form-label">Course Name *</label>
                <input className="form-input" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <input className="form-input" value={description} onChange={e => setDescription(e.target.value)} placeholder="What is this course about?" />
              </div>
              <div className="form-group">
                <label className="form-label">Department / School (Genre)</label>
                <select className="select" value={genre} onChange={e => setGenre(e.target.value)}>
                  {GENRES.filter(g => g !== "All").map(g => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary btn-sm" onClick={saveSettings} disabled={metaLoading}>
                {metaLoading ? "Saving…" : "Save Settings"}
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

// ─── COURSE DETAIL MODAL ──────────────────────────────────────────────────────
// Member view: see shared calendars and member list
function CourseDetailModal({ ctx, courseId, course }) {
  const { sessionId, closeModal } = ctx;
  const [sharedCalIds,   setSharedCalIds]   = React.useState([]);
  const [calDetails,     setCalDetails]     = React.useState({});
  const [loading,        setLoading]        = React.useState(true);
  const [members,        setMembers]        = React.useState([]);
  const [membersLoading, setMembersLoading] = React.useState(true);
  const [activeSection,  setActiveSection]  = React.useState("calendars");
  const col = courseColor(courseId);

  async function loadCals() {
    setLoading(true);
    try {
      const res = await courseCalApi("GetOrganizationCalendars", { organizationId: Number(courseId) }, sessionId);
      const ids = (res.calendarIds || []).map(String);
      setSharedCalIds(ids);
      const details = {};
      await Promise.allSettled(ids.map(async (id) => {
        try {
          const d = await calApi("GetCalendar", { calendarId: Number(id) }, sessionId);
          details[id] = { id, ...d };
        } catch(e) {}
      }));
      setCalDetails(details);
    } catch(e) {
      setSharedCalIds([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadMembers() {
    setMembersLoading(true);
    try {
      const res = await courseMemApi("GetOrganizationMembers", { organizationId: Number(courseId) }, sessionId);
      const ids = res.memberUserIds || [];
      const resolved = await Promise.all(ids.map(async (uid) => {
        try {
          const u = await apiCall("/users.v2.UserService/GetUser", { userId: uid }, sessionId);
          const name = [u.firstName, u.middleName, u.lastName].filter(Boolean).join(" ");
          return { id: uid, name: name || `User #${uid}` };
        } catch(e) {
          return { id: uid, name: `User #${uid}` };
        }
      }));
      setMembers(resolved);
    } catch(e) {
      setMembers([]);
    } finally {
      setMembersLoading(false);
    }
  }

  React.useEffect(() => { loadCals(); loadMembers(); }, [courseId]);

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display:"flex", alignItems:"center", gap:12, flex:1 }}>
            <div style={{
              width:36, height:36, borderRadius:10, background:col+"22",
              border:`1.5px solid ${col}55`, display:"flex", alignItems:"center",
              justifyContent:"center", fontWeight:800, fontSize:13, color:col,
              fontFamily:"var(--font-head)",
            }}>
              {courseInitials(course.name)}
            </div>
            <div>
              <div className="modal-title">{course.name}</div>
              <div style={{ display:"flex", gap:6, marginTop:3 }}>
                {course.genre && (
                  <span style={{ fontSize:10, padding:"2px 8px", borderRadius:4,
                    background:genreColor(course.genre)+"22", color:genreColor(course.genre),
                    fontWeight:700, border:`1px solid ${genreColor(course.genre)}44` }}>
                    {course.genre}
                  </span>
                )}
                {course.description && (
                  <span style={{ fontSize:12, color:"var(--text3)" }}>{course.description}</span>
                )}
              </div>
            </div>
          </div>
          <button className="close-btn" onClick={closeModal}>✕</button>
        </div>
        <div className="modal-body">
          {/* Section switcher */}
          <div style={{ display:"flex", gap:4, marginBottom:18, background:"var(--surface2)", borderRadius:10, padding:3, border:"1px solid var(--border)", width:"fit-content" }}>
            {[["calendars","📅 Shared Calendars"],["members","👥 Students"]].map(([s,l]) => (
              <div key={s} onClick={() => setActiveSection(s)} style={{
                padding:"7px 16px", borderRadius:8, fontSize:13, fontWeight:600, cursor:"pointer",
                background: activeSection===s ? "var(--accent)" : "transparent",
                color: activeSection===s ? "#fff" : "var(--text2)",
                transition:"all .15s",
              }}>{l}</div>
            ))}
          </div>

          {/* Calendars */}
          {activeSection === "calendars" && (
            loading ? (
              <div style={{ textAlign:"center", padding:"24px 0", color:"var(--text3)", fontSize:13 }}>Loading…</div>
            ) : sharedCalIds.length === 0 ? (
              <div style={{ textAlign:"center", padding:"32px 0", color:"var(--text3)" }}>
                <div style={{ fontSize:32, marginBottom:8 }}>📭</div>
                <div style={{ fontSize:13 }}>No calendars have been shared to this course yet.</div>
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {sharedCalIds.map(id => {
                  const cal = calDetails[id];
                  if (!cal) return null;
                  return (
                    <div key={id} style={{ padding:"14px 16px", borderRadius:12, background:"var(--surface2)", border:"1px solid var(--border)" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <div style={{ width:10, height:10, borderRadius:"50%", background: PALETTE[Math.abs(Number(id)||0) % PALETTE.length], flexShrink:0 }} />
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:14, fontWeight:700, color:"var(--text)" }}>{cal.name || `Calendar #${id}`}</div>
                          {cal.description && <div style={{ fontSize:12, color:"var(--text3)" }}>{cal.description}</div>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}

          {/* Members / Students */}
          {activeSection === "members" && (
            membersLoading ? (
              <div style={{ textAlign:"center", padding:"24px 0", color:"var(--text3)", fontSize:13 }}>Loading students…</div>
            ) : members.length === 0 ? (
              <div style={{ textAlign:"center", padding:"32px 0", color:"var(--text3)" }}>
                <div style={{ fontSize:28, marginBottom:8 }}>👤</div>
                <div style={{ fontSize:13 }}>No students enrolled yet.</div>
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                <div style={{ fontSize:12, color:"var(--text3)", marginBottom:6 }}>{members.length} student{members.length !== 1 ? "s" : ""}</div>
                {members.map((m, i) => (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderRadius:10, background:"var(--surface2)", border:"1px solid var(--border)" }}>
                    <div style={{ width:30, height:30, borderRadius:"50%",
                      background: PALETTE[i % PALETTE.length] + "33",
                      border: `1.5px solid ${PALETTE[i % PALETTE.length]}55`,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontSize:12, fontWeight:700, color: PALETTE[i % PALETTE.length], flexShrink:0 }}>
                      {(m.name||"?")[0]?.toUpperCase()}
                    </div>
                    <div style={{ fontSize:14, fontWeight:600, color:"var(--text)" }}>{m.name}</div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={closeModal}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── COURSE MEMBERS MODAL ─────────────────────────────────────────────────────
function CourseMembersModal({ ctx, courseId, course }) {
  const { sessionId, closeModal } = ctx;
  const [members, setMembers] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const col = courseColor(courseId);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await courseMemApi("GetOrganizationMembers", { organizationId: Number(courseId) }, sessionId);
        const ids = res.memberUserIds || [];
        const resolved = await Promise.all(ids.map(async (uid) => {
          try {
            const u = await apiCall("/users.v2.UserService/GetUser", { userId: uid }, sessionId);
            const name = [u.firstName, u.middleName, u.lastName].filter(Boolean).join(" ");
            return { id: uid, name: name || `User #${uid}` };
          } catch(e) {
            return { id: uid, name: `User #${uid}` };
          }
        }));
        setMembers(resolved);
      } catch(e) {
        setMembers([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [courseId]);

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display:"flex", alignItems:"center", gap:10, flex:1 }}>
            <div style={{
              width:32, height:32, borderRadius:8, background:col+"22",
              border:`1.5px solid ${col}55`, display:"flex", alignItems:"center",
              justifyContent:"center", fontWeight:800, fontSize:12, color:col,
            }}>
              {courseInitials(course.name)}
            </div>
            <div>
              <div className="modal-title" style={{ fontSize:15 }}>{course.name}</div>
              <div style={{ fontSize:12, color:"var(--text3)" }}>Enrolled Students</div>
            </div>
          </div>
          <button className="close-btn" onClick={closeModal}>✕</button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div style={{ textAlign:"center", padding:"32px 0", color:"var(--text3)", fontSize:13 }}>Loading students…</div>
          ) : members.length === 0 ? (
            <div style={{ textAlign:"center", padding:"40px 0", color:"var(--text3)" }}>
              <div style={{ fontSize:32, marginBottom:8 }}>👤</div>
              <div style={{ fontSize:13 }}>No students enrolled yet.</div>
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <div style={{ fontSize:12, color:"var(--text3)", marginBottom:8 }}>
                {members.length} student{members.length !== 1 ? "s" : ""}
              </div>
              {members.map((m, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderRadius:10, background:"var(--surface2)", border:"1px solid var(--border)" }}>
                  <div style={{
                    width:30, height:30, borderRadius:"50%",
                    background: PALETTE[i % PALETTE.length] + "33",
                    border: `1.5px solid ${PALETTE[i % PALETTE.length]}55`,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:12, fontWeight:700, color: PALETTE[i % PALETTE.length], flexShrink:0,
                  }}>
                    {(m.name||"?")[0]?.toUpperCase()}
                  </div>
                  <div style={{ fontSize:14, fontWeight:600, color:"var(--text)" }}>{m.name}</div>
                </div>
              ))}
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