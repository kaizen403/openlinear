export function Footer() {
  return (
    <footer className="border-t border-foreground/10 mt-20 px-6 md:px-20 py-10">
      <div className="mx-auto max-w-content flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <p className="text-[14px] text-muted-foreground">
          &copy; {new Date().getFullYear()} OpenLinear
        </p>
        <div className="flex items-center gap-6">
          <a href="https://openlinear.mintlify.app" className="text-[14px] text-muted-foreground hover:text-foreground transition-colors">
            Docs
          </a>
          <a href="https://github.com/kaizen403/openlinear" className="text-[14px] text-muted-foreground hover:text-foreground transition-colors">
            GitHub
          </a>
          <a href="https://x.com/openlinear" className="text-[14px] text-muted-foreground hover:text-foreground transition-colors">
            X
          </a>
        </div>
      </div>
    </footer>
  )
}
