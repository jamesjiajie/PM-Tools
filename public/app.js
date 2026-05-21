const { createApp } = Vue;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STATUSES = ["未开始", "进行中", "已完成", "风险"];
const EMPTY_FORM = {
  name: "",
  owner: "",
  phase: "",
  start: "2026-04-24",
  end: "2026-04-30",
  progress: 0,
  status: "未开始",
  critical: false,
  milestone: false,
  parentId: "",
};

function todayIso() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createTaskForm(overrides = {}) {
  const today = todayIso();
  return {
    ...EMPTY_FORM,
    start: today,
    end: today,
    ...overrides,
  };
}

createApp({
  data() {
    return {
      currentView: "gantt",
      projects: [],
      activeProjectId: "",
      projectName: "电商小程序开发计划",
      projectNameDraft: "",
      isEditingProjectName: false,
      tasks: [],
      filters: {
        keyword: "",
        status: "all",
        criticalOnly: false,
      },
      statuses: STATUSES,
      dayWidth: 52,
      today: new Date(`${todayIso()}T00:00:00`),
      isLoading: true,
      isSaving: false,
      saveMessage: "所有更改已保存",
      errorMessage: "",
      formOpen: false,
      editingTask: null,
      form: createTaskForm(),
      formError: "",
      progressDrag: null,
      endDateDrag: null,
      taskMoveDrag: null,
      suppressBarClick: false,
      projectFormOpen: false,
      projectForm: {
        name: "",
      },
      projectFormError: "",
    };
  },

  computed: {
    sortedTasks() {
      return [...this.tasks].sort((a, b) => new Date(a.start) - new Date(b.start));
    },

    taskRows() {
      const childrenByParent = new Map();
      const roots = [];

      this.sortedTasks.forEach((task) => {
        if (task.parentId) {
          const children = childrenByParent.get(task.parentId) || [];
          children.push(task);
          childrenByParent.set(task.parentId, children);
        } else {
          roots.push(task);
        }
      });

      return roots.flatMap((task) => {
        const children = childrenByParent.get(task.id) || [];
        return [
          { ...task, level: 0, childCount: children.length },
          ...children.map((child) => ({ ...child, level: 1, childCount: 0 })),
        ];
      });
    },

    visibleTasks() {
      const keyword = this.filters.keyword.trim().toLowerCase();

      return this.taskRows.filter((task) => {
        const matchesKeyword = [task.name, task.owner, task.phase]
          .join(" ")
          .toLowerCase()
          .includes(keyword);
        const matchesStatus = this.filters.status === "all" || task.status === this.filters.status;
        const matchesCritical = !this.filters.criticalOnly || task.critical;
        return matchesKeyword && matchesStatus && matchesCritical;
      });
    },

    visibleTaskRows() {
      const keyword = this.filters.keyword.trim().toLowerCase();
      const visibleIds = new Set(this.visibleTasks.map((task) => task.id));

      this.tasks.forEach((task) => {
        if (visibleIds.has(task.id) && task.parentId) visibleIds.add(task.parentId);
        if (keyword && visibleIds.has(task.id)) {
          this.tasks.filter((child) => child.parentId === task.id).forEach((child) => visibleIds.add(child.id));
        }
      });

      return this.taskRows.filter((task) => visibleIds.has(task.id));
    },

    parentTaskOptions() {
      const editingId = this.editingTask?.id || "";
      return this.sortedTasks.filter((task) => !task.parentId && task.id !== editingId);
    },

    ganttStart() {
      if (this.taskMoveDrag?.anchorStart) return new Date(`${this.taskMoveDrag.anchorStart}T00:00:00`);
      if (!this.tasks.length) return new Date("2026-04-24T00:00:00");
      return new Date(`${this.minByDate(this.tasks, "start").start}T00:00:00`);
    },

    ganttEnd() {
      if (!this.tasks.length) return new Date("2026-04-30T00:00:00");
      return new Date(`${this.maxByDate(this.tasks, "end").end}T00:00:00`);
    },

    timelineDays() {
      const totalDays = this.daysBetween(this.ganttStart, this.ganttEnd) + 1;

      return Array.from({ length: totalDays }, (_, index) => {
        const date = new Date(this.ganttStart);
        date.setDate(this.ganttStart.getDate() + index);

        return {
          iso: date.toISOString().slice(0, 10),
          label: `${date.getMonth() + 1}/${date.getDate()}`,
          weekday: "日一二三四五六"[date.getDay()],
        };
      });
    },

    timelineWidth() {
      return this.timelineDays.length * this.dayWidth;
    },

    ganttStyle() {
      return {
        minWidth: `${320 + this.timelineWidth}px`,
      };
    },

    todayOffset() {
      return this.daysBetween(this.ganttStart, this.today);
    },

    showTodayLine() {
      return this.todayOffset >= 0 && this.todayOffset < this.timelineDays.length && this.visibleTaskRows.length > 0;
    },

    dateRangeLabel() {
      return `${this.formatDate(this.toIso(this.ganttStart))} - ${this.formatDate(this.toIso(this.ganttEnd))}`;
    },

    summary() {
      if (!this.tasks.length) {
        return {
          overallProgress: 0,
          riskCount: 0,
          endDate: "-",
        };
      }

      const overallProgress = Math.round(
        this.tasks.reduce((sum, task) => sum + Number(task.progress), 0) / this.tasks.length,
      );
      const riskCount = this.tasks.filter((task) => task.status === "风险").length;

      return {
        overallProgress,
        riskCount,
        endDate: this.formatDate(this.maxByDate(this.tasks, "end").end),
      };
    },
  },

  async mounted() {
    this.currentView = window.location.hash === "#/projects" ? "projects" : "gantt";
    window.addEventListener("hashchange", this.syncRoute);
    this.syncDayWidth();
    window.addEventListener("resize", this.syncDayWidth);
    await this.loadProjects();
  },

  beforeUnmount() {
    window.removeEventListener("hashchange", this.syncRoute);
    window.removeEventListener("resize", this.syncDayWidth);
    this.stopProgressListeners();
    this.stopEndDateListeners();
    this.stopTaskMoveListeners();
  },

  methods: {
    syncRoute() {
      this.currentView = window.location.hash === "#/projects" ? "projects" : "gantt";
    },

    navigate(view) {
      this.currentView = view;
      window.location.hash = view === "projects" ? "#/projects" : "#/gantt";
    },

    async loadProjects() {
      this.errorMessage = "";

      try {
        const response = await fetch("/api/projects");
        if (!response.ok) throw new Error("项目列表加载失败");
        this.projects = await response.json();

        if (!this.projects.length) {
          this.openProjectForm();
          this.isLoading = false;
          return;
        }

        const nextProjectId =
          this.activeProjectId && this.projects.some((project) => project.id === this.activeProjectId)
            ? this.activeProjectId
            : this.projects[0].id;
        await this.selectProject(nextProjectId, false);
      } catch (error) {
        this.errorMessage = error.message;
        this.isLoading = false;
      }
    },

    async loadProject(projectId = this.activeProjectId) {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
        if (!response.ok) throw new Error("项目名称加载失败");
        const project = await response.json();
        this.projectName = project.name;
        this.activeProjectId = project.id;
      } catch (error) {
        this.errorMessage = error.message;
      }
    },

    async loadTasks(projectId = this.activeProjectId) {
      if (!projectId) return;
      this.isLoading = true;
      this.errorMessage = "";

      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks`);
        if (!response.ok) throw new Error("项目数据加载失败");
        this.tasks = (await response.json()).map((task) => ({ parentId: "", ...task }));
        this.saveMessage = "所有更改已保存";
      } catch (error) {
        this.errorMessage = error.message;
      } finally {
        this.isLoading = false;
      }
    },

    async selectProject(projectId, showGantt = true) {
      this.activeProjectId = projectId;
      this.filters.keyword = "";
      this.filters.status = "all";
      this.filters.criticalOnly = false;
      this.cancelProjectNameEdit();
      await Promise.all([this.loadProject(projectId), this.loadTasks(projectId)]);
      if (showGantt) {
        this.navigate("gantt");
      }
    },

    startProjectNameEdit() {
      this.projectNameDraft = this.projectName;
      this.isEditingProjectName = true;
      this.$nextTick(() => {
        this.$refs.projectNameInput?.focus();
      });
    },

    cancelProjectNameEdit() {
      this.projectNameDraft = "";
      this.isEditingProjectName = false;
    },

    async saveProjectName() {
      const nextName = this.projectNameDraft.trim();

      if (!nextName) {
        this.errorMessage = "项目名称不能为空";
        return;
      }

      try {
        const project = await this.request(`/api/projects/${encodeURIComponent(this.activeProjectId)}`, {
          method: "PUT",
          body: JSON.stringify({ name: nextName }),
        });
        this.projectName = project.name;
        await this.loadProjectsSummaryOnly();
        this.cancelProjectNameEdit();
      } catch (error) {
        this.errorMessage = error.message;
      }
    },

    async loadProjectsSummaryOnly() {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error("项目列表刷新失败");
      this.projects = await response.json();
    },

    openProjectForm() {
      this.projectForm = { name: "" };
      this.projectFormError = "";
      this.projectFormOpen = true;
      this.$nextTick(() => {
        document.querySelector(".compact-modal input")?.focus();
      });
    },

    closeProjectForm() {
      this.projectFormOpen = false;
      this.projectFormError = "";
    },

    async submitProjectForm() {
      const name = this.projectForm.name.trim();

      if (!name) {
        this.projectFormError = "项目名称不能为空";
        return;
      }

      try {
        const project = await this.request("/api/projects", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        await this.loadProjectsSummaryOnly();
        this.closeProjectForm();
        await this.selectProject(project.id);
      } catch (error) {
        this.projectFormError = error.message;
      }
    },

    async deleteProject(project) {
      const confirmed = window.confirm(`删除项目「${project.name}」？项目下的任务也会一起删除。`);
      if (!confirmed) return;

      try {
        await this.request(`/api/projects/${encodeURIComponent(project.id)}`, {
          method: "DELETE",
        });
        await this.loadProjectsSummaryOnly();

        if (this.activeProjectId !== project.id) return;

        const nextProject = this.projects[0];
        if (nextProject) {
          await this.selectProject(nextProject.id, false);
        } else {
          this.activeProjectId = "";
          this.projectName = "电商小程序开发计划";
          this.tasks = [];
          this.openProjectForm();
        }
      } catch (error) {
        this.errorMessage = error.message;
      }
    },

    async request(url, options) {
      this.isSaving = true;
      this.saveMessage = "保存中";

      try {
        const response = await fetch(url, {
          headers: { "Content-Type": "application/json" },
          ...options,
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "保存失败");
        this.saveMessage = "所有更改已保存";
        return payload;
      } catch (error) {
        this.saveMessage = "保存失败";
        throw error;
      } finally {
        this.isSaving = false;
      }
    },

    async updateTask(task, patch) {
      const nextTask = { ...task, ...patch };

      try {
        const savedTask = await this.request(
          `/api/projects/${encodeURIComponent(this.activeProjectId)}/tasks/${encodeURIComponent(task.id)}`,
          {
          method: "PUT",
          body: JSON.stringify(nextTask),
          },
        );
        this.tasks = this.tasks.map((item) => (item.id === task.id ? { parentId: "", ...savedTask } : item));
        await this.loadProjectsSummaryOnly();
      } catch (error) {
        this.errorMessage = error.message;
      }
    },

    openCreateForm() {
      this.editingTask = null;
      this.form = createTaskForm();
      this.formError = "";
      this.formOpen = true;
    },

    openCreateSubtaskForm(task) {
      this.editingTask = null;
      this.form = createTaskForm({
        parentId: task.id,
        owner: task.owner,
        phase: task.phase,
      });
      this.formError = "";
      this.formOpen = true;
    },

    openTaskFromBar(task) {
      if (this.suppressBarClick) {
        this.suppressBarClick = false;
        return;
      }

      this.openEditForm(task);
    },

    openEditForm(task) {
      this.editingTask = task;
      this.form = { ...task };
      this.formError = "";
      this.formOpen = true;
    },

    closeForm() {
      this.formOpen = false;
      this.formError = "";
    },

    async submitForm() {
      this.formError = "";

      if (new Date(this.form.start) > new Date(this.form.end)) {
        this.formError = "开始日期不能晚于结束日期";
        return;
      }

      try {
        if (this.editingTask) {
          const savedTask = await this.request(
            `/api/projects/${encodeURIComponent(this.activeProjectId)}/tasks/${encodeURIComponent(this.editingTask.id)}`,
            {
              method: "PUT",
              body: JSON.stringify(this.form),
            },
          );
          this.tasks = this.tasks.map((task) => (task.id === savedTask.id ? { parentId: "", ...savedTask } : task));
        } else {
          const savedTask = await this.request(`/api/projects/${encodeURIComponent(this.activeProjectId)}/tasks`, {
            method: "POST",
            body: JSON.stringify(this.form),
          });
          this.tasks.push({ parentId: "", ...savedTask });
        }

        await this.loadProjectsSummaryOnly();
        this.closeForm();
      } catch (error) {
        this.formError = error.message;
      }
    },

    async deleteCurrentTask() {
      if (!this.editingTask) return;

      try {
        await this.request(
          `/api/projects/${encodeURIComponent(this.activeProjectId)}/tasks/${encodeURIComponent(this.editingTask.id)}`,
          {
            method: "DELETE",
          },
        );
        this.tasks = this.tasks.filter((task) => task.id !== this.editingTask.id && task.parentId !== this.editingTask.id);
        await this.loadProjectsSummaryOnly();
        this.closeForm();
      } catch (error) {
        this.formError = error.message;
      }
    },

    startProgressDrag(task, event) {
      const bar = event.currentTarget.closest(".bar");
      if (!bar) return;

      this.progressDrag = {
        taskId: task.id,
        rect: bar.getBoundingClientRect(),
        startX: event.clientX,
        moved: false,
      };

      window.addEventListener("pointermove", this.handleProgressDrag);
      window.addEventListener("pointerup", this.finishProgressDrag, { once: true });
    },

    handleProgressDrag(event) {
      if (!this.progressDrag) return;

      const { rect, startX, taskId } = this.progressDrag;
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return;

      const nextProgress = Math.max(0, Math.min(100, Math.round(((event.clientX - rect.left) / rect.width) * 100)));

      if (Math.abs(event.clientX - startX) > 2) {
        this.progressDrag.moved = true;
      }

      this.tasks = this.tasks.map((item) =>
        item.id === taskId ? { ...item, progress: nextProgress } : item,
      );
    },

    async finishProgressDrag() {
      if (!this.progressDrag) return;

      const { taskId, moved } = this.progressDrag;
      this.stopProgressListeners();

      if (!moved) return;

      this.suppressBarClick = true;
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return;

      await this.updateTask(task, { progress: task.progress });
    },

    stopProgressListeners() {
      window.removeEventListener("pointermove", this.handleProgressDrag);
      window.removeEventListener("pointerup", this.finishProgressDrag);
      this.progressDrag = null;
    },

    startEndDateDrag(task, event) {
      const timeline = event.currentTarget.closest(".timeline");
      if (!timeline) return;

      const startDate = new Date(`${task.start}T00:00:00`);

      this.endDateDrag = {
        taskId: task.id,
        timelineRect: timeline.getBoundingClientRect(),
        startOffset: this.daysBetween(this.ganttStart, startDate),
        startX: event.clientX,
        moved: false,
      };

      window.addEventListener("pointermove", this.handleEndDateDrag);
      window.addEventListener("pointerup", this.finishEndDateDrag, { once: true });
    },

    handleEndDateDrag(event) {
      if (!this.endDateDrag) return;

      const { timelineRect, startOffset, startX, taskId } = this.endDateDrag;
      const targetOffset = Math.max(startOffset, Math.floor((event.clientX - timelineRect.left) / this.dayWidth));
      const nextEndDate = new Date(this.ganttStart);
      nextEndDate.setDate(this.ganttStart.getDate() + targetOffset);
      const nextEnd = this.toIso(nextEndDate);

      if (Math.abs(event.clientX - startX) > 2) {
        this.endDateDrag.moved = true;
      }

      this.tasks = this.tasks.map((task) => (task.id === taskId ? { ...task, end: nextEnd } : task));
    },

    async finishEndDateDrag() {
      if (!this.endDateDrag) return;

      const { taskId, moved } = this.endDateDrag;
      this.stopEndDateListeners();

      if (!moved) return;

      this.suppressBarClick = true;
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return;

      await this.updateTask(task, { end: task.end });
    },

    stopEndDateListeners() {
      window.removeEventListener("pointermove", this.handleEndDateDrag);
      window.removeEventListener("pointerup", this.finishEndDateDrag);
      this.endDateDrag = null;
    },

    startTaskMovePress(task, event) {
      if (event.target.closest(".bar-handle, .bar-end-handle")) return;

      const startDate = new Date(`${task.start}T00:00:00`);
      const endDate = new Date(`${task.end}T00:00:00`);
      const anchorStart = this.toIso(this.ganttStart);

      this.taskMoveDrag = {
        taskId: task.id,
        anchorStart,
        startOffset: this.daysBetween(new Date(`${anchorStart}T00:00:00`), startDate),
        duration: this.daysBetween(startDate, endDate),
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        moved: false,
        timer: window.setTimeout(() => {
          if (!this.taskMoveDrag || this.taskMoveDrag.taskId !== task.id) return;
          this.taskMoveDrag.active = true;
          this.suppressBarClick = true;
        }, 260),
      };

      window.addEventListener("pointermove", this.handleTaskMoveDrag);
      window.addEventListener("pointerup", this.finishTaskMoveDrag, { once: true });
      window.addEventListener("pointercancel", this.cancelTaskMoveDrag, { once: true });
    },

    handleTaskMoveDrag(event) {
      if (!this.taskMoveDrag) return;

      const { active, anchorStart, duration, startOffset, startX, startY, taskId } = this.taskMoveDrag;
      const distance = Math.hypot(event.clientX - startX, event.clientY - startY);

      if (!active) {
        if (distance > 6) this.cancelTaskMoveDrag();
        return;
      }

      const deltaDays = Math.round((event.clientX - startX) / this.dayWidth);
      const nextStartOffset = Math.max(0, startOffset + deltaDays);
      const anchorDate = new Date(`${anchorStart}T00:00:00`);
      const nextStart = new Date(anchorDate);
      const nextEnd = new Date(anchorDate);
      nextStart.setDate(anchorDate.getDate() + nextStartOffset);
      nextEnd.setDate(anchorDate.getDate() + nextStartOffset + duration);

      if (Math.abs(deltaDays) > 0) this.taskMoveDrag.moved = true;

      this.tasks = this.tasks.map((task) =>
        task.id === taskId ? { ...task, start: this.toIso(nextStart), end: this.toIso(nextEnd) } : task,
      );
    },

    async finishTaskMoveDrag() {
      if (!this.taskMoveDrag) return;

      const { active, moved, taskId } = this.taskMoveDrag;
      this.stopTaskMoveListeners();

      if (!active || !moved) return;

      this.suppressBarClick = true;
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return;

      await this.updateTask(task, { start: task.start, end: task.end });
    },

    cancelTaskMoveDrag() {
      this.stopTaskMoveListeners();
    },

    stopTaskMoveListeners() {
      if (this.taskMoveDrag?.timer) window.clearTimeout(this.taskMoveDrag.timer);
      window.removeEventListener("pointermove", this.handleTaskMoveDrag);
      window.removeEventListener("pointerup", this.finishTaskMoveDrag);
      window.removeEventListener("pointercancel", this.cancelTaskMoveDrag);
      this.taskMoveDrag = null;
    },

    barStyle(task) {
      const startOffset = this.daysBetween(this.ganttStart, new Date(`${task.start}T00:00:00`));
      const duration = this.daysBetween(new Date(`${task.start}T00:00:00`), new Date(`${task.end}T00:00:00`)) + 1;

      return {
        left: `${startOffset * this.dayWidth + 8}px`,
        width: `${Math.max(duration * this.dayWidth - 16, 26)}px`,
      };
    },

    milestoneStyle(task) {
      const startOffset = this.daysBetween(this.ganttStart, new Date(`${task.start}T00:00:00`));
      const duration = this.daysBetween(new Date(`${task.start}T00:00:00`), new Date(`${task.end}T00:00:00`)) + 1;
      return {
        left: `${(startOffset + duration - 0.7) * this.dayWidth}px`,
      };
    },

    syncDayWidth() {
      this.dayWidth = Number.parseInt(
        getComputedStyle(document.documentElement).getPropertyValue("--day-width"),
        10,
      );
    },

    statusClass(status) {
      return {
        进行中: "in-progress",
        未开始: "todo",
        已完成: "done",
        风险: "risk",
      }[status];
    },

    daysBetween(start, end) {
      return Math.round((end - start) / MS_PER_DAY);
    },

    formatDate(dateString) {
      const date = new Date(`${dateString}T00:00:00`);
      return `${date.getMonth() + 1}/${date.getDate()}`;
    },

    minByDate(items, key) {
      return [...items].sort((a, b) => new Date(a[key]) - new Date(b[key]))[0];
    },

    maxByDate(items, key) {
      return [...items].sort((a, b) => new Date(b[key]) - new Date(a[key]))[0];
    },

    toIso(date) {
      return date.toISOString().slice(0, 10);
    },
  },
}).mount("#app");
