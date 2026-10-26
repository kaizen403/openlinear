export function TestimonialsSection() {
  return (
    <section className="py-16 md:py-20 overflow-hidden">
      <div className="relative">
        <div className="absolute left-0 top-0 bottom-0 w-24 bg-gradient-to-r from-background to-transparent z-10 pointer-events-none" />
        <div className="absolute right-0 top-0 bottom-0 w-24 bg-gradient-to-l from-background to-transparent z-10 pointer-events-none" />

        <div className="flex animate-marquee gap-5 w-max">
          {[...testimonials, ...testimonials].map((t, i) => (
            <TweetCard key={`tweet-${t.handle}-${i}`} {...t} />
          ))}
        </div>
      </div>
    </section>
  )
}

const testimonials = [
  {
    name: "Nikhil Rao",
    handle: "@nikhilrao_",
    avatarUrl: "https://i.pravatar.cc/80?img=11",
    tweet: "openlinear has been running on my machine for about a week now. it picked up a ticket, wrote the code, opened a PR. i literally reviewed and merged it from my phone. this tool is unreal",
    time: "4:32 PM",
    date: "Mar 12, 2026",
  },
  {
    name: "Chloe Tran",
    handle: "@chloetran_dev",
    avatarUrl: "https://i.pravatar.cc/80?img=5",
    tweet: "replaced three different tools with openlinear last week. board, agent, code review, all in one place. my workflow is so much cleaner now it feels wrong",
    time: "11:18 AM",
    date: "Mar 9, 2026",
  },
  {
    name: "Tom Ashworth",
    handle: "@tashworth",
    avatarUrl: "https://i.pravatar.cc/80?img=12",
    tweet: "the local first thing is not a gimmick. my board loads before i can even think. and the ai agents run on my infra so nothing leaves my machine. this is how dev tools should work",
    time: "9:45 PM",
    date: "Mar 7, 2026",
  },
  {
    name: "Ananya Gupta",
    handle: "@ananyag",
    avatarUrl: "https://i.pravatar.cc/80?img=23",
    tweet: "ok i was skeptical but openlinear actually understands my codebase. it doesn't just autocomplete, it reasons about the architecture and writes code that fits. i'm mass adopting this across the team",
    time: "2:03 PM",
    date: "Mar 11, 2026",
  },
  {
    name: "Ryan Peters",
    handle: "@ryanpeters_",
    avatarUrl: "https://i.pravatar.cc/80?img=53",
    tweet: "been building solo for two years. openlinear is the first tool that actually feels like having another engineer on the team. it just picks up tasks and does them. i can finally focus on product",
    time: "8:17 AM",
    date: "Mar 14, 2026",
  },
  {
    name: "Mia Chen",
    handle: "@miac_eng",
    avatarUrl: "https://i.pravatar.cc/80?img=9",
    tweet: "multi repo support in openlinear is so good. i have a monorepo with 4 services and the agents switch context between them without any issues. actually shipping faster now",
    time: "6:51 PM",
    date: "Mar 10, 2026",
  },
  {
    name: "James Okonkwo",
    handle: "@jamesokon",
    avatarUrl: "https://i.pravatar.cc/80?img=59",
    tweet: "just watched openlinear write a migration, update the tests, and open a clean PR in about 4 minutes. i need to rethink what i spend my time on lol",
    time: "10:22 PM",
    date: "Mar 13, 2026",
  },
]

function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function TweetCard({
  name,
  handle,
  avatarUrl,
  tweet,
  time,
  date,
}: {
  name: string
  handle: string
  avatarUrl: string
  tweet: string
  time: string
  date: string
}) {
  return (
    <div className="flex-shrink-0 w-[min(360px,85vw)] rounded-xl border border-white/[0.06] p-5 bg-white/[0.03] backdrop-blur-xl flex flex-col">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <img
            src={avatarUrl}
            alt={name}
            className="h-10 w-10 rounded-full object-cover"
            loading="lazy"
          />
          <div>
            <p className="text-[15px] font-semibold leading-tight text-foreground">{name}</p>
            <p className="text-[13px] text-muted-foreground leading-tight">{handle}</p>
          </div>
        </div>
        <XLogo className="h-[18px] w-[18px] text-foreground/40 shrink-0 mt-0.5" />
      </div>

      <p className="text-[15px] leading-[22px] text-foreground/90 flex-1 mb-3">{tweet}</p>

      <p className="text-[13px] text-muted-foreground">
        {time} · {date}
      </p>
    </div>
  )
}
