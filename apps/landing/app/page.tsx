import Navbar from '@/components/navbar'
import AnnouncementBanner from '@/components/announcement-banner'
import Hero from '@/components/hero'
import Features from '@/components/features'
import Stats from '@/components/stats'
import Privacy from '@/components/privacy'
import FAQ from '@/components/faq'
import AgentsCTA from '@/components/agents-cta'
import Newsletter from '@/components/newsletter'
import Footer from '@/components/footer'

export default function Home() {
  return (
    <main className="min-h-screen">
      <Navbar />
      <AnnouncementBanner />
      <Hero />
      <Features />
      <Stats />
      <Privacy />
      <FAQ />
      <AgentsCTA />
      <Newsletter />
      <Footer />
    </main>
  )
}
