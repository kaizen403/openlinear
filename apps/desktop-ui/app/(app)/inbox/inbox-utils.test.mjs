import { describe, it, expect } from "vitest"
import {
  startOfDay,
  bucketFor,
  timeAgo,
  BUCKET_LABEL,
  BUCKET_ORDER,
  TYPE_META,
  FILTER_CHIPS,
} from "./inbox-utils"

describe("inbox-utils", () => {
  describe("startOfDay", () => {
    it("returns the start of the day", () => {
      const d = new Date("2026-05-31T14:30:00Z")
      const result = startOfDay(d)
      const resultDate = new Date(result)
      expect(resultDate.getHours()).toBe(0)
      expect(resultDate.getMinutes()).toBe(0)
      expect(resultDate.getSeconds()).toBe(0)
      expect(resultDate.getMilliseconds()).toBe(0)
    })
  })

  describe("bucketFor", () => {
    it("returns 'today' for today", () => {
      const now = new Date("2026-05-31T14:00:00Z").getTime()
      expect(bucketFor("2026-05-31T10:00:00Z", now)).toBe("today")
    })

    it("returns 'week' for within 6 days", () => {
      const now = new Date("2026-05-31T14:00:00Z").getTime()
      expect(bucketFor("2026-05-25T10:00:00Z", now)).toBe("week")
    })

    it("returns 'older' for more than 6 days ago", () => {
      const now = new Date("2026-05-31T14:00:00Z").getTime()
      expect(bucketFor("2026-05-23T10:00:00Z", now)).toBe("older")
    })
  })

  describe("timeAgo", () => {
    it("returns seconds for recent timestamps", () => {
      const now = new Date("2026-05-31T14:00:00Z").getTime()
      expect(timeAgo("2026-05-31T14:00:30Z", now)).toContain("second")
    })

    it("returns minutes for timestamps within an hour", () => {
      const now = new Date("2026-05-31T14:00:00Z").getTime()
      expect(timeAgo("2026-05-31T13:30:00Z", now)).toContain("minute")
    })

    it("returns hours for timestamps within a day", () => {
      const now = new Date("2026-05-31T14:00:00Z").getTime()
      expect(timeAgo("2026-05-31T06:00:00Z", now)).toContain("hour")
    })

    it("returns days for timestamps within a week", () => {
      const now = new Date("2026-05-31T14:00:00Z").getTime()
      expect(timeAgo("2026-05-28T14:00:00Z", now)).toContain("day")
    })

    it("returns weeks for timestamps within a month", () => {
      const now = new Date("2026-05-31T14:00:00Z").getTime()
      expect(timeAgo("2026-05-10T14:00:00Z", now)).toContain("week")
    })

    it("returns locale date for older timestamps", () => {
      const now = new Date("2026-05-31T14:00:00Z").getTime()
      const result = timeAgo("2026-01-01T14:00:00Z", now)
      expect(result).toContain("/")
    })
  })

  describe("constants", () => {
    it("BUCKET_LABEL has correct labels", () => {
      expect(BUCKET_LABEL).toEqual({
        today: "Today",
        week: "This week",
        older: "Older",
      })
    })

    it("BUCKET_ORDER has correct order", () => {
      expect(BUCKET_ORDER).toEqual(["today", "week", "older"])
    })

    it("TYPE_META has metadata for all types", () => {
      expect(TYPE_META).toHaveProperty("mention")
      expect(TYPE_META).toHaveProperty("assignment")
      expect(TYPE_META).toHaveProperty("status_change")
      expect(TYPE_META).toHaveProperty("comment")
    })

    it("FILTER_CHIPS has correct chips", () => {
      expect(FILTER_CHIPS.map((c) => c.id)).toEqual([
        "all",
        "mention",
        "assignment",
        "status_change",
      ])
    })
  })
})
