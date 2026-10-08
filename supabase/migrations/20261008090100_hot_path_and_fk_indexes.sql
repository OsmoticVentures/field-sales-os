-- Indexes for the hot paths pg_stat_statements and the Performance Advisor named
-- on 2026-10-08. Additive only. Each CREATE INDEX CONCURRENTLY runs on its own
-- (it cannot share a transaction), so apply this file statement by statement.

-- The nightly sync-log prune asks for the newest id older than a cutoff per
-- direction. Without this it walked the primary key backwards through every
-- recent row: 10.5 s a call on 276k rows.
create index concurrently if not exists nb_hubspot_sync_log_direction_at_idx
  on public.nb_hubspot_sync_log (direction, at) include (id);

-- The change fingerprint every poller reads first (newest updated_at), about
-- 60k calls on nb_accounts since the stats reset.
create index concurrently if not exists nb_accounts_updated_at_idx on public.nb_accounts (updated_at desc);
create index concurrently if not exists nb_contacts_updated_at_idx on public.nb_contacts (updated_at desc);

-- Foreign keys with no index behind them (advisor: unindexed_foreign_keys).
-- Each makes a delete or merge of the parent row a lookup instead of a scan.
-- A nullable key gets a partial index over the rows that hold a value, which
-- is all a foreign-key check reads, so a mostly empty column costs almost
-- nothing. Left out on purpose: nb_account_scores.config_version, a full index
-- on the largest append-only table for a parent that is never deleted.
create index concurrently if not exists nb_account_briefs_synthetic_dataset_id_fk_idx on public.nb_account_briefs (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_account_scores_synthetic_dataset_id_fk_idx on public.nb_account_scores (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_accounts_synthetic_dataset_id_fk_idx on public.nb_accounts (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_activities_route_stop_id_fk_idx on public.nb_activities (route_stop_id) where route_stop_id is not null;
create index concurrently if not exists nb_activities_contact_id_fk_idx on public.nb_activities (contact_id) where contact_id is not null;
create index concurrently if not exists nb_activities_synthetic_dataset_id_fk_idx on public.nb_activities (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_activity_retractions_duplicate_of_fk_idx on public.nb_activity_retractions (duplicate_of) where duplicate_of is not null;
create index concurrently if not exists nb_calendar_proposals_account_id_fk_idx on public.nb_calendar_proposals (account_id) where account_id is not null;
create index concurrently if not exists nb_calendar_proposals_touchpoint_id_fk_idx on public.nb_calendar_proposals (touchpoint_id) where touchpoint_id is not null;
create index concurrently if not exists nb_close_signals_activity_id_fk_idx on public.nb_close_signals (activity_id) where activity_id is not null;
create index concurrently if not exists nb_contacts_synthetic_dataset_id_fk_idx on public.nb_contacts (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_deal_stage_events_evidence_activity_id_fk_idx on public.nb_deal_stage_events (evidence_activity_id) where evidence_activity_id is not null;
create index concurrently if not exists nb_deals_contact_id_fk_idx on public.nb_deals (contact_id) where contact_id is not null;
create index concurrently if not exists nb_deals_synthetic_dataset_id_fk_idx on public.nb_deals (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_directives_account_id_fk_idx on public.nb_directives (account_id) where account_id is not null;
create index concurrently if not exists nb_directives_field_note_id_fk_idx on public.nb_directives (field_note_id) where field_note_id is not null;
create index concurrently if not exists nb_email_poll_log_matched_account_id_fk_idx on public.nb_email_poll_log (matched_account_id) where matched_account_id is not null;
create index concurrently if not exists nb_email_poll_log_matched_contact_id_fk_idx on public.nb_email_poll_log (matched_contact_id) where matched_contact_id is not null;
create index concurrently if not exists nb_field_notes_activity_id_fk_idx on public.nb_field_notes (activity_id) where activity_id is not null;
create index concurrently if not exists nb_field_notes_touchpoint_id_fk_idx on public.nb_field_notes (touchpoint_id) where touchpoint_id is not null;
create index concurrently if not exists nb_import_rows_applied_contact_id_fk_idx on public.nb_import_rows (applied_contact_id) where applied_contact_id is not null;
create index concurrently if not exists nb_jobs_depends_on_fk_idx on public.nb_jobs (depends_on) where depends_on is not null;
create index concurrently if not exists nb_order_emails_account_id_fk_idx on public.nb_order_emails (account_id) where account_id is not null;
create index concurrently if not exists nb_order_lines_synthetic_dataset_id_fk_idx on public.nb_order_lines (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_orders_activity_id_fk_idx on public.nb_orders (activity_id) where activity_id is not null;
create index concurrently if not exists nb_orders_deal_id_fk_idx on public.nb_orders (deal_id) where deal_id is not null;
create index concurrently if not exists nb_orders_synthetic_dataset_id_fk_idx on public.nb_orders (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_outbound_drafts_contact_id_fk_idx on public.nb_outbound_drafts (contact_id) where contact_id is not null;
create index concurrently if not exists nb_outbound_drafts_synthetic_dataset_id_fk_idx on public.nb_outbound_drafts (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_promo_codes_template_id_fk_idx on public.nb_promo_codes (template_id) where template_id is not null;
create index concurrently if not exists nb_report_drafts_user_id_fk_idx on public.nb_report_drafts (user_id);
create index concurrently if not exists nb_report_metrics_user_id_fk_idx on public.nb_report_metrics (user_id);
create index concurrently if not exists nb_route_plan_revisions_day_id_fk_idx on public.nb_route_plan_revisions (day_id) where day_id is not null;
create index concurrently if not exists nb_route_plans_synthetic_dataset_id_fk_idx on public.nb_route_plans (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_route_stops_outcome_activity_id_fk_idx on public.nb_route_stops (outcome_activity_id) where outcome_activity_id is not null;
create index concurrently if not exists nb_sample_drops_activity_id_fk_idx on public.nb_sample_drops (activity_id) where activity_id is not null;
create index concurrently if not exists nb_sample_drops_converted_order_id_fk_idx on public.nb_sample_drops (converted_order_id) where converted_order_id is not null;
create index concurrently if not exists nb_sample_drops_sample_id_fk_idx on public.nb_sample_drops (sample_id);
create index concurrently if not exists nb_samples_synthetic_dataset_id_fk_idx on public.nb_samples (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_score_config_proposals_from_version_fk_idx on public.nb_score_config_proposals (from_version) where from_version is not null;
create index concurrently if not exists nb_sdr_schedule_completed_activity_id_fk_idx on public.nb_sdr_schedule (completed_activity_id) where completed_activity_id is not null;
create index concurrently if not exists nb_support_issues_contact_id_fk_idx on public.nb_support_issues (contact_id) where contact_id is not null;
create index concurrently if not exists nb_support_issues_synthetic_dataset_id_fk_idx on public.nb_support_issues (synthetic_dataset_id) where synthetic_dataset_id is not null;
create index concurrently if not exists nb_touchpoints_activity_id_fk_idx on public.nb_touchpoints (activity_id) where activity_id is not null;
create index concurrently if not exists nb_visit_recordings_account_id_hint_fk_idx on public.nb_visit_recordings (account_id_hint) where account_id_hint is not null;
create index concurrently if not exists nb_visit_recordings_touchpoint_id_fk_idx on public.nb_visit_recordings (touchpoint_id) where touchpoint_id is not null;
