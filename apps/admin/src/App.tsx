import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { HomePage } from './routes/HomePage';
import { AnalyticsPage } from './routes/AnalyticsPage';
import { AppearancePage } from './routes/AppearancePage';
import { BillingPage } from './routes/BillingPage';
import { ButtonsPage } from './routes/ButtonsPage';
import { FormsPage } from './routes/FormsPage';
import { FormBuilderPage } from './routes/FormBuilderPage';
import { FraudPage } from './routes/FraudPage';
import { GoogleSheetsPage } from './routes/GoogleSheetsPage';
import { NotFoundPage } from './routes/NotFoundPage';
import { OrdersPage } from './routes/OrdersPage';
import { PixelsPage } from './routes/PixelsPage';
import { VisibilityPage } from './routes/VisibilityPage';
import { FeesPage } from './routes/FeesPage';
import { BackupPage } from './routes/BackupPage';
import { UpsellsPage } from './routes/UpsellsPage';
import { OrderBumpsPage } from './routes/OrderBumpsPage';

/**
 * Route table.
 *
 * `AppShell` wraps every route rather than sitting inside each one, so the
 * session is fetched once and every screen can assume it exists. Later phases
 * hang their pages — orders, analytics, settings — off this list.
 */
export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/forms" element={<FormsPage />} />
        <Route path="/forms/:formId" element={<FormBuilderPage />} />
        <Route path="/buttons" element={<ButtonsPage />} />
        <Route path="/settings/appearance" element={<AppearancePage />} />
        {/*
          The Settings nav entry needs somewhere to point. Redirecting to the
          section's first tab keeps one canonical URL per screen, so a deep
          link, a browser refresh and the sidebar all land in the same place.
        */}
        <Route path="/settings" element={<Navigate to="/settings/visibility" replace />} />
        <Route path="/settings/visibility" element={<VisibilityPage />} />
        <Route path="/settings/fees" element={<FeesPage />} />
        <Route path="/settings/backup" element={<BackupPage />} />
        <Route path="/upsells" element={<UpsellsPage />} />
        <Route path="/upsells/bumps" element={<OrderBumpsPage />} />
        <Route path="/settings/sheets" element={<GoogleSheetsPage />} />
        <Route path="/settings/pixels" element={<PixelsPage />} />
        <Route path="/settings/fraud" element={<FraudPage />} />
        <Route path="/settings/billing" element={<BillingPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
