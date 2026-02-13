import { ArrowRight } from 'lucide-react'

export default function AnnouncementBanner() {
  return (
    <div className="pt-14">
      <div className="border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-2">
          <a
            href="https://github.com/kaizen403/openlinear/releases/latest"
            className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors group"
          >
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/10 text-foreground">
              New
            </span>
            <span>Desktop app available on macOS and Linux. Download now</span>
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>
      </div>
    </div>
  )
}
