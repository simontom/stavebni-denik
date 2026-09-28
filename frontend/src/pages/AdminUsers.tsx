import React, { useState } from 'react';

interface User {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'USER';
  isActive: boolean;
}

export const AdminUsers: React.FC = () => {
  const [users, setUsers] = useState<User[]>([
    { id: '1', name: 'Alice Admin', email: 'alice@example.com', role: 'ADMIN', isActive: true },
    { id: '2', name: 'Bob Builder', email: 'bob@example.com', role: 'MANAGER', isActive: true },
    { id: '3', name: 'Charlie Contractor', email: 'charlie@example.com', role: 'USER', isActive: false },
  ]);

  const handleRoleChange = (userId: string, newRole: User['role']) => {
    setUsers(users.map(u => u.id === userId ? { ...u, role: newRole } : u));
  };

  const toggleStatus = (userId: string) => {
    setUsers(users.map(u => u.id === userId ? { ...u, isActive: !u.isActive } : u));
  };

  return (
    <div className="admin-users-page">
      <h1>Manage Users</h1>
      
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
        <thead>
          <tr style={{ backgroundColor: '#f5f5f5', textAlign: 'left' }}>
            <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Name</th>
            <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Email</th>
            <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Role</th>
            <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Status</th>
            <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map(user => (
            <tr key={user.id}>
              <td style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>{user.name}</td>
              <td style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>{user.email}</td>
              <td style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>
                <select 
                  value={user.role} 
                  onChange={(e) => handleRoleChange(user.id, e.target.value as User['role'])}
                >
                  <option value="ADMIN">Admin</option>
                  <option value="MANAGER">Manager</option>
                  <option value="USER">User</option>
                </select>
              </td>
              <td style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>
                <span style={{ color: user.isActive ? 'green' : 'red', fontWeight: 'bold' }}>
                  {user.isActive ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>
                <button onClick={() => toggleStatus(user.id)}>
                  {user.isActive ? 'Deactivate' : 'Activate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
