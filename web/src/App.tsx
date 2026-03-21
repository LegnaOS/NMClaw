import { useState } from 'react'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Models from './pages/Models'
import Skills from './pages/Skills'
import Mcps from './pages/Mcps'
import Agents from './pages/Agents'
import Tasks from './pages/Tasks'
import Chat from './pages/Chat'
import Graphs from './pages/Graphs'
import ClawHub from './pages/ClawHub'
import Cron from './pages/Cron'
import Channels from './pages/Channels'

export type Page = 'chat' | 'dashboard' | 'models' | 'skills' | 'mcps' | 'agents' | 'tasks' | 'graphs' | 'clawhub' | 'cron' | 'channels'

export default function App() {
  const [page, setPage] = useState<Page>('chat')

  return (
    <Layout currentPage={page} onNavigate={setPage}>
      {/* Chat stays mounted for persistent state; others remount on navigate for fresh data */}
      <div className={`h-full ${page === 'chat' ? '' : 'hidden'}`}><Chat /></div>
      {page === 'dashboard' && <Dashboard />}
      {page === 'models' && <Models />}
      {page === 'skills' && <Skills />}
      {page === 'mcps' && <Mcps />}
      {page === 'agents' && <Agents />}
      {page === 'tasks' && <Tasks />}
      {page === 'graphs' && <Graphs />}
      {page === 'clawhub' && <ClawHub />}
      {page === 'cron' && <Cron />}
      {page === 'channels' && <Channels />}
    </Layout>
  )
}
