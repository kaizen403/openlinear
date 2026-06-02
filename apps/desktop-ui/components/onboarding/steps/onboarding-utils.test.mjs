import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  deriveTeamKey,
  deriveDefaultTeamName,
  deriveProjectNameFromUrl,
  getRepoUrl,
  getOwnerLogin,
  hasRepoSelection,
  getRepoSummary,
  getDefaultBranchSuggestions,
  loadStoredDraft,
  saveStoredDraft,
  clearStoredDraft,
  EMPTY_REPO_DRAFT,
  STORAGE_KEY,
} from "./onboarding-utils"

describe("onboarding-utils", () => {
  describe("deriveTeamKey", () => {
    it("creates initials from words", () => {
      expect(deriveTeamKey("Frontend Team")).toBe("FT")
    })

    it("falls back to TEAM for empty strings", () => {
      expect(deriveTeamKey("")).toBe("TEAM")
      expect(deriveTeamKey("   ")).toBe("TEAM")
    })

    it("strips special characters and uses first word's initial", () => {
      expect(deriveTeamKey("A&I-Team")).toBe("A")
    })

    it("prepends T if first char is not a letter", () => {
      expect(deriveTeamKey("123 Squad")).toBe("T1S")
    })

    it("truncates to 10 chars", () => {
      expect(deriveTeamKey("Very Long Team Name")).toBe("VLTN")
    })
  })

  describe("deriveDefaultTeamName", () => {
    it("appends Team to project name", () => {
      expect(deriveDefaultTeamName("OpenLinear")).toBe("OpenLinear Team")
    })

    it("does not duplicate Team suffix", () => {
      expect(deriveDefaultTeamName("Engineering Team")).toBe("Engineering Team")
    })

    it("trims and normalizes whitespace", () => {
      expect(deriveDefaultTeamName("  My   Project  ")).toBe("My Project Team")
    })

    it("falls back to Project Team for null/undefined", () => {
      expect(deriveDefaultTeamName(null)).toBe("Project Team")
      expect(deriveDefaultTeamName(undefined)).toBe("Project Team")
    })
  })

  describe("deriveProjectNameFromUrl", () => {
    it("extracts repo name from GitHub HTTPS URL", () => {
      expect(deriveProjectNameFromUrl("https://github.com/kaizen403/openlinear")).toBe("openlinear")
    })

    it("extracts repo name from SSH URL", () => {
      expect(deriveProjectNameFromUrl("git@github.com:kaizen403/openlinear.git")).toBe("openlinear")
    })

    it("returns empty for invalid URLs", () => {
      expect(deriveProjectNameFromUrl("not-a-url")).toBe("")
    })
  })

  describe("getRepoUrl", () => {
    it("returns html_url when available", () => {
      expect(getRepoUrl({ html_url: "https://github.com/a/b", full_name: "a/b" })).toBe("https://github.com/a/b")
    })

    it("falls back to constructed URL", () => {
      expect(getRepoUrl({ full_name: "a/b" })).toBe("https://github.com/a/b")
    })
  })

  describe("getOwnerLogin", () => {
    it("returns owner.login when available", () => {
      expect(getOwnerLogin({ owner: { login: "kaizen" }, full_name: "kaizen/openlinear" })).toBe("kaizen")
    })

    it("parses full_name as fallback", () => {
      expect(getOwnerLogin({ full_name: "kaizen/openlinear" })).toBe("kaizen")
    })

    it("returns github for empty full_name", () => {
      expect(getOwnerLogin({ full_name: "" })).toBe("github")
    })
  })

  describe("hasRepoSelection", () => {
    it("checks selectedRepo for github source", () => {
      expect(hasRepoSelection({ ...EMPTY_REPO_DRAFT, source: "github", selectedRepo: { full_name: "a/b" } })).toBe(true)
      expect(hasRepoSelection({ ...EMPTY_REPO_DRAFT, source: "github" })).toBe(false)
    })

    it("checks repoUrl for link source", () => {
      expect(hasRepoSelection({ ...EMPTY_REPO_DRAFT, source: "link", repoUrl: "https://github.com/a/b" })).toBe(true)
      expect(hasRepoSelection({ ...EMPTY_REPO_DRAFT, source: "link" })).toBe(false)
    })

    it("checks sshUrl for ssh source", () => {
      expect(hasRepoSelection({ ...EMPTY_REPO_DRAFT, source: "ssh", sshUrl: "git@github.com:a/b.git" })).toBe(true)
      expect(hasRepoSelection({ ...EMPTY_REPO_DRAFT, source: "ssh" })).toBe(false)
    })
  })

  describe("getRepoSummary", () => {
    it("returns full_name for github source", () => {
      expect(getRepoSummary({ ...EMPTY_REPO_DRAFT, source: "github", selectedRepo: { full_name: "a/b" } })).toBe("a/b")
    })

    it("returns cleaned URL for link source", () => {
      expect(getRepoSummary({ ...EMPTY_REPO_DRAFT, source: "link", repoUrl: "https://github.com/a/b" })).toBe("a/b")
    })

    it("returns cleaned SSH for ssh source", () => {
      expect(getRepoSummary({ ...EMPTY_REPO_DRAFT, source: "ssh", sshUrl: "git@github.com:a/b.git" })).toBe("a/b.git")
    })

    it("returns null when nothing is selected", () => {
      expect(getRepoSummary(EMPTY_REPO_DRAFT)).toBe(null)
    })
  })

  describe("getDefaultBranchSuggestions", () => {
    it("returns unique non-empty branches", () => {
      expect(getDefaultBranchSuggestions({ ...EMPTY_REPO_DRAFT, selectedRepo: { default_branch: "main" }, defaultBranch: "main" })).toEqual(["main"])
    })

    it("returns empty for no branches", () => {
      expect(getDefaultBranchSuggestions({ ...EMPTY_REPO_DRAFT, defaultBranch: "" })).toEqual([])
    })
  })

  describe("localStorage draft persistence", () => {
    beforeEach(() => {
      window.localStorage.clear()
    })

    it("saves and loads a draft", () => {
      const draft = { currentStep: 2, workspaceName: "Acme", projectName: "Widget", repoDraft: EMPTY_REPO_DRAFT, teamName: "Widget Team" }
      saveStoredDraft(draft)
      const loaded = loadStoredDraft()
      expect(loaded).toMatchObject(draft)
    })

    it("returns null when no draft is stored", () => {
      expect(loadStoredDraft()).toBe(null)
    })

    it("clears the draft", () => {
      saveStoredDraft({ currentStep: 1, workspaceName: "X", projectName: "Y", repoDraft: EMPTY_REPO_DRAFT, teamName: "Z" })
      clearStoredDraft()
      expect(loadStoredDraft()).toBe(null)
    })

    it("returns null for malformed JSON", () => {
      window.localStorage.setItem(STORAGE_KEY, "not-json")
      expect(loadStoredDraft()).toBe(null)
    })
  })
})
