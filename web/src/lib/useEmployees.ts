import { useCallback, useEffect, useState } from 'react';
import type { Employee } from '../../../shared/settings';
import { api } from './api';

export function useEmployees() {
  const [list, setList] = useState<Employee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<Employee[]>('GET', '/api/employees').then(
      (r) => { setList(r); setError(null); },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(reload, [reload]);
  return { list, error, reload };
}
