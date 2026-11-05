import type { Attachment, Bill, BillItem, Customer, OcrJob, Product } from './types'

type Table<Row, Insert = Partial<Row>, Update = Partial<Insert>> = {
  Row: Row
  Insert: Insert & Record<string, unknown>
  Update: Update & Record<string, unknown>
  Relationships: []
}

/**
 * One row of `organizations`: the company the workspace belongs to.
 *
 * Only the columns the browser is allowed to read or write are named. The
 * update grant on this table covers exactly these six, and the policy allows
 * only an admin to change them.
 */
export type OrganizationRow = {
  id: string
  name: string
  gstin: string | null
  state_code: string | null
  address: string | null
  phone: string | null
  email: string | null
  created_at: string
  updated_at: string
}

export type CountResult = { count: number | null }

export type Database = {
  public: {
    Tables: {
      customers: Table<Customer>
      products: Table<Product>
      bills: Table<Bill>
      bill_items: Table<BillItem>
      bill_attachments: Table<Attachment>
      ocr_jobs: Table<OcrJob>
      import_batches: Table<Record<string, unknown>>
      memberships: Table<Record<string, unknown>>
      organizations: Table<OrganizationRow>
      audit_logs: Table<Record<string, unknown>>
      storage_objects: Table<Record<string, unknown>>
    }
    Views: Record<string, never>
    Functions: {
      save_bill: { Args: { payload: Record<string, unknown>; allow_duplicate?: boolean }; Returns: { bill: Bill; items: BillItem[]; attachments: Attachment[]; duplicate_warnings: Array<Record<string, unknown>> } }
      update_bill: { Args: { target_bill_id: string; payload: Record<string, unknown>; allow_duplicate?: boolean; expected_version?: number | null }; Returns: { bill: Bill; items: BillItem[]; attachments: Attachment[]; duplicate_warnings: Array<Record<string, unknown>> } }
      soft_delete_bill: { Args: { target_bill_id: string; reason?: string | null }; Returns: Record<string, unknown> }
      restore_bill: { Args: { target_bill_id: string }; Returns: Record<string, unknown> }
      bootstrap_organization: { Args: { org_name: string; org_gstin?: string | null; org_state_code?: string | null; user_full_name?: string | null }; Returns: Record<string, unknown> }
      /**
       * Join an existing organization, added by db/migrations/0044_join_organization.sql.
       * Search is open to any signed-in user; join always lands as viewer and is
       * refused for anyone who already belongs to an organization.
       */
      search_organizations: {
        Args: { p_gstin?: string | null; p_name?: string | null }
        Returns: Array<{ id: string; name: string; gstin: string | null; state_code: string | null }>
      }
      join_organization: { Args: { p_org_id: string }; Returns: Record<string, unknown> }
      add_organization_member: { Args: { org_id: string; member_email: string; member_role?: string }; Returns: Record<string, unknown> }
      /**
       * Employee access, added by db/migrations/0020_employee_roles.sql.
       * All three are admin-only and are refused by the server for anyone else,
       * so the frontend check is a convenience rather than the protection.
       */
      set_organization_member_role: { Args: { target_user_id: string; new_role: string }; Returns: Record<string, unknown> }
      deactivate_organization_member: { Args: { target_user_id: string }; Returns: Record<string, unknown> }
      list_organization_members: {
        Args: { target_organization_id?: string | null }
        Returns: Array<{ user_id: string; email: string | null; full_name: string | null; role: string; member_since: string; is_you: boolean }>
      }
      current_user_identity: {
        Args: Record<string, never>
        Returns: Array<{ user_id: string | null; email: string | null; full_name: string | null }>
      }
      set_customer_verification: { Args: { target_customer_id: string; new_status: string }; Returns: Customer }
      dashboard_summary: { Args: { org_id: string }; Returns: { total_customers: number; total_bills: number; total_sales: number; current_fy_sales: number; pending_amount: number; bills_this_month: number } }
      customer_summary: { Args: { target_customer_id: string }; Returns: { bill_count: number; total_purchase: number; total_gst: number; average_bill: number; last_bill: string | null } }
      customer_products: { Args: { target_customer_id: string }; Returns: Array<{ product_name: string; quantity: number; total_amount: number; last_purchased: string }> }
      report_summary: { Args: { org_id: string; start_date: string; end_date: string }; Returns: { taxable: number; cgst: number; sgst: number; igst: number; total_gst: number; cess: number; sales: number; bills: number; pending: number } }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}