import React, { useState, useEffect } from 'react';

interface AuditLog {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  resource: string;
  details: string;
}

export const AuditLogViewer: React.FC = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Mock API fetch
    const fetchLogs = () => {
      setTimeout(() => {
        setLogs([
          {
            id: 'log-1',
            timestamp: '2023-10-05T14:22:10Z',
            user: 'alice@example.com',
            action: 'UPDATE_ROLE',
            resource: 'User: 3',
            details: 'Changed role from USER to MANAGER',
          },
          {
            id: 'log-2',
            timestamp: '2023-10-05T13:10:00Z',
            user: 'bob@example.com',
            action: 'CREATE_REPORT',
            resource: 'Report: 42',
            details: 'Created daily construction report',
          },
          {
            id: 'log-3',
            timestamp: '2023-10-04T09:05:33Z',
            user: 'system',
            action: 'BACKUP_COMPLETE',
            resource: 'Database',
            details: 'Automated daily backup successful',
          }
        ]);
        setLoading(false);
      }, 500);
    };

    fetchLogs();
  }, []);

  if (loading) {
    return <div>Loading audit logs...</div>;
  }

  return (
    <div className="audit-log-viewer">
      <h1>System Audit Logs</h1>
      <p>Immutable record of system activities.</p>
      
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
        <thead>
          <tr style={{ backgroundColor: '#2c3e50', color: 'white', textAlign: 'left' }}>
            <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Timestamp</th>
            <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>User</th>
            <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Action</th>
            <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Resource</th>
            <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Details</th>
          </tr>
        </thead>
        <tbody>
          {logs.map(log => (
            <tr key={log.id}>
              <td style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>
                {new Date(log.timestamp).toLocaleString()}
              </td>
              <td style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>{log.user}</td>
              <td style={{ padding: '12px', borderBottom: '1px solid #ddd', fontWeight: 'bold' }}>{log.action}</td>
              <td style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>{log.resource}</td>
              <td style={{ padding: '12px', borderBottom: '1px solid #ddd', color: '#555' }}>{log.details}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
