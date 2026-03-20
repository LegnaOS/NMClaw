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

export type Page = 'chat' | 'dashboard' | 'models' | 'skills' | 'mcps' | 'agents' | 'tasks' | 'graphs' | 'clawhub' | 'cron'

export default function App() {
  const [page, setPage] = useState<Page>('chat')

  return (
    <Layout currentPage={page} onNavigate={setPage}>
      <div className={`h-full ${page === 'chat' ? '' : 'hidden'}`}><Chat /></div>
      <div className={`h-full ${page === 'dashboard' ? '' : 'hidden'}`}><Dashboard /></div>
      <div className={`h-full ${page === 'models' ? '' : 'hidden'}`}><Models /></div>
      <div className={`h-full ${page === 'skills' ? '' : 'hidden'}`}><Skills /></div>
      <div className={`h-full ${page === 'mcps' ? '' : 'hidden'}`}><Mcps /></div>
      <div className={`h-full ${page === 'agents' ? '' : 'hidden'}`}><Agents /></div>
      <div className={`h-full ${page === 'tasks' ? '' : 'hidden'}`}><Tasks /></div>
      <div className={`h-full ${page === 'graphs' ? '' : 'hidden'}`}><Graphs /></div>
      <div className={`h-full ${page === 'clawhub' ? '' : 'hidden'}`}><ClawHub /></div>
      <div className={`h-full ${page === 'cron' ? '' : 'hidden'}`}><Cron /></div>
    </Layout>
  )
}
